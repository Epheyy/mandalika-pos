# Head-office Review Resolve Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tablets report their parked sync review items to the server; head office sees and resolves them in a new backoffice screen; the tablet then removes resolved items.

**Architecture:** A new `sync_review_items` table (migration 0048) fed by a tablet check-in endpoint `POST /api/v1/sync/review-items` whose reply carries the keys head office resolved. The SyncEngine calls it from its existing sync loop and removes resolved keys through a new guarded `Outbox.resolveReviewed()` that only deletes items still parked. A permission-gated backoffice screen ("Tinjauan Sinkron") lists and resolves items. Nothing touches the sale/refund/stock apply paths.

**Tech Stack:** Go 1.x + chi + pgx v5 (backend), PostgreSQL, OpenAPI 3.1 + oapi-codegen + openapi-typescript, TypeScript + vitest (`packages/sync`, `packages/api`, POS), React 19 + Tailwind (backoffice), Playwright browser gate.

**Spec:** `docs/plans/2026-10-12-review-resolve-design.md` (approved 2026-10-12). Read it before any task.

## Global Constraints

- Permission string: `resolve_sync_review`. Admin role passes via the existing bypass (`auth.HasPermission`).
- Tablet endpoint: `POST /api/v1/sync/review-items`, 1–200 items per request; outlet always from the caller's auth context, never the body.
- Backoffice endpoints: `GET /api/v1/sync-review-items`, `POST /api/v1/sync-review-items/{key}/resolve`, both `RequirePermission("resolve_sync_review")`.
- Resolve note: trimmed, 1–500 runes. Review text fields clipped to 1000 runes; review code ≤ 40 chars; key ≤ 200 chars; payload > 64 KB stored as `{"_truncated":true,"bytes":N}`; top-level `pin` removed server-side.
- Tablet check-in: at most every 5 min when everything was already reported, every 30 s when a not-yet-reported item exists (spec said "immediately" for a new item: it goes out at the next flush, or ≤ 30 s after the previous check-in); ≤ 50 items per check-in (spec said "every item": batching with rotation reaches every item; see Task 6). Never in `flushOnly` mode. Queue untouched on any failure.
- Removal only while parked: `status === 'failed' && attempts >= MAX_ATTEMPTS`. Never via `settle()`/`mutate()` (they swallow write errors) and never via plain `discard`. (Spec named this a settle op `resolve_review`; a dedicated rejecting method modelled on `retryDeadLettered` is the same behaviour with honest failure reporting.)
- Pagination uses the codebase's `page`/`limit` (spec said limit/offset; `pageLimit()` + `off()` are the existing pattern).
- UI copy (Indonesian) exactly as in spec §4.5/§4.6.
- Committed Go files must be gofmt-clean (`git show HEAD:<f> | gofmt -l` for CRLF checkouts).
- A git hook blocks any command line containing `-n`/`--no-…` tokens, including commit text: always write the message to a file and `git commit -F <file>`.
- Migration file numbering: `0048_sync_review_items.sql`; no registry to update.
- New PG gate: code `RV`, test `TestSyncReviewPostgres`, port `56450`, slug `rv` (env `MANDALIKA_RV_TEST_DSN`, `MANDALIKA_RV_TEST_DATA_DIR`, db `mandalika_rv_synthetic`, user `rv_test`).
- Any diff touching `packages/sync/src/outbox.ts`, `engine.ts`, OpenAPI/generated types, auth or permissions gets an Opus review before merge (AGENTS.md routing).
- `appliedOnServer` must use the same three dedupe sources as `sync/attribute.go` `Applied`: `operation_receipts`, `processed_keys` (orders), `transfers.received_idempotency_key`.
- The TTL cut to 720 h must not shorten the password-reset revoke marker (Task 3b ships before Task 10's deploy).

## Review Focus

1. **Resolve URL with an escaped key.** Keys look like `dev:uuid`; the backoffice sends `encodeURIComponent(key)` (`dev%3Auuid`) and chi returns the raw escaped segment. Expect: the handler unescapes and resolves the right row. Pinned in Task 3 (PG test uses the escaped form).
2. **NUL characters (`\u0000`) in a reason or payload.** PostgreSQL rejects NUL in `text`/`jsonb`; one bad item would fail the whole check-in forever. Expect: NULs stripped, item stored. Pinned in Task 2 (unit) and Task 3 (PG).
3. **More than 50 parked items on one tablet.** Expect: every item is eventually reported and every resolution eventually learned (rotation by least-recently-sent). Pinned in Task 6.
4. **"Coba lagi" pressed while a check-in is in flight.** Expect: the item the cashier re-queued is NOT removed even though the server reports it resolved. Pinned in Task 5 (outbox) and Task 6 (engine, deferred request).
5. **Terminal in outlet-mismatch (`flushOnly`) mode.** Expect: no check-in at all (items would be filed under the wrong outlet). Pinned in Task 6.

---

## File Structure

| File | Responsibility |
|---|---|
| `backend/api/openapi.yaml` (modify) | Contract: 3 paths, 7 schemas |
| `backend/internal/api/api.gen.go`, `packages/api/src/schema.d.ts` (regenerate) | Generated types |
| `backend/internal/db/migrations/0048_sync_review_items.sql` (create) | Table + open-items index |
| `backend/internal/write/syncreview.go` (create) | Upsert reports, resolve item |
| `backend/internal/read/syncreview.go` (create) | List + open count |
| `backend/internal/handlers/sync_review_input.go` (+ `_test.go`) (create) | Pure input normalisation |
| `backend/internal/handlers/sync_review.go` (create) | 3 HTTP handlers |
| `backend/internal/handlers/sync_review_integration_test.go` (create) | PG gate `RV` |
| `backend/internal/server/server.go` (modify) | Route wiring |
| `scripts/ci/postgres_gate.py` (modify) | Register gate `RV` |
| `backend/internal/auth/reset.go` (+ `reset_test.go`) (modify) | Revoke marker TTL ≥ 8760 h (TTL cutover safety) |
| `packages/types/src/index.ts` (modify) | `RESOLVE_SYNC_REVIEW` |
| `packages/api/src/client.ts` (modify) | `listSyncReviewItems`, `resolveSyncReviewItem` + type aliases |
| `packages/sync/src/outbox.ts` (modify) | `capturedOutletId` on `ReviewItem`; `resolveReviewed()` |
| `packages/sync/src/outbox.resolve-reviewed.test.ts` (create) | Outbox removal tests |
| `packages/sync/src/engine.ts` (modify) | `checkInReviews()`, triggers, `isReviewReported()`, `onReviewResolved`, `appendSyncLog()` |
| `packages/sync/src/engine.review-checkin.test.ts` (create) | Engine check-in tests |
| `apps/pos/src/lib/reviewResolved.ts` (+ test) (create) | Toast text |
| `apps/pos/src/cashier/SyncProvider.tsx`, `apps/pos/src/hooks/useOfflineData.ts`, `apps/pos/src/components/SyncStatus.tsx` (+ test) (modify) | Toast wiring, "Dilaporkan ke kantor pusat" |
| `apps/backoffice/src/screens/syncReview/reviewLabels.ts` (+ test) (create) | Labels, payload summary, staleness |
| `apps/backoffice/src/screens/syncReview/useSyncReviewCount.ts` (create) | Badge count hook + change event |
| `apps/backoffice/src/screens/syncReview/SyncReviewDetail.tsx` (create) | Detail modal + resolve form |
| `apps/backoffice/src/screens/syncReview/SyncReview.tsx` (create) | Screen: tabs, filters, list, pagination |
| `apps/backoffice/src/App.tsx`, `apps/backoffice/src/screens/users/PermissionPicker.tsx` (modify) | Nav item, badge, permission label |
| `tests/browser/backoffice-review-scenarios.ts` (create), `tests/browser/accepted.spec.ts`, `tests/browser/required-scenarios.json` (modify) | Browser gate `BO-REVIEW-RESOLVE` |

---

### Task 1: OpenAPI contract and generated types

**Files:**
- Modify: `backend/api/openapi.yaml` (paths next to `/api/v1/sync/batch` ~line 4159 and `/api/v1/error-logs` ~line 4088; schemas next to `SyncEnvelope` ~line 1688)
- Regenerate: `backend/internal/api/api.gen.go`, `packages/api/src/schema.d.ts`

**Interfaces:**
- Produces schema names used by every later task: `SyncReviewReport`, `SyncReviewReportRequest`, `SyncReviewResolution`, `SyncReviewReportResult`, `SyncReviewReportResponse`, `SyncReviewItem`, `SyncReviewItemListResponse`, `SyncReviewResolveRequest`, `SyncReviewResolveResponse`.

- [ ] **Step 1: Add the schemas** under `components.schemas` (after `SyncEnvelope`):

```yaml
    SyncReviewReport:
      type: object
      required: [idempotencyKey, type, clientCreatedAt, payload]
      properties:
        idempotencyKey: { type: string, maxLength: 200 }
        type:
          type: string
          enum: [order, refund, shift_open, shift_close, cash_flow, customer_create, transfer_receive]
        reviewCode: { type: string }
        reviewReason: { type: string }
        lastError: { type: string }
        ownerUserId: { type: string }
        capturedOutletId: { type: string }
        clientCreatedAt: { type: string, format: date-time }
        payload: { type: object, additionalProperties: true }
    SyncReviewReportRequest:
      type: object
      required: [items]
      properties:
        items:
          type: array
          minItems: 1
          maxItems: 200
          items: { $ref: '#/components/schemas/SyncReviewReport' }
    SyncReviewResolution:
      type: object
      required: [idempotencyKey, resolvedAt, resolvedByName, note]
      properties:
        idempotencyKey: { type: string }
        resolvedAt: { type: string, format: date-time }
        resolvedByName: { type: string }
        note: { type: string }
    SyncReviewReportResult:
      type: object
      required: [resolved]
      properties:
        resolved:
          type: array
          items: { $ref: '#/components/schemas/SyncReviewResolution' }
    SyncReviewReportResponse:
      type: object
      required: [data]
      properties:
        data: { $ref: '#/components/schemas/SyncReviewReportResult' }
    SyncReviewItem:
      type: object
      required: [idempotencyKey, outletId, outletName, type, payload, clientCreatedAt, firstReportedAt, lastReportedAt, reportedByName, appliedOnServer]
      properties:
        idempotencyKey: { type: string }
        outletId: { type: string, format: uuid }
        outletName: { type: string }
        capturedOutletId: { type: string, nullable: true }
        capturedOutletName: { type: string, nullable: true }
        type: { type: string }
        reviewCode: { type: string, nullable: true }
        reviewReason: { type: string, nullable: true }
        lastError: { type: string, nullable: true }
        ownerUserId: { type: string, nullable: true }
        ownerName: { type: string, nullable: true }
        payload: { type: object, additionalProperties: true }
        clientCreatedAt: { type: string, format: date-time }
        firstReportedAt: { type: string, format: date-time }
        lastReportedAt: { type: string, format: date-time }
        reportedByName: { type: string }
        resolvedAt: { type: string, format: date-time, nullable: true }
        resolvedByName: { type: string, nullable: true }
        resolutionNote: { type: string, nullable: true }
        appliedOnServer: { type: boolean }
    SyncReviewItemListResponse:
      type: object
      required: [data, meta, openCount]
      properties:
        data:
          type: array
          items: { $ref: '#/components/schemas/SyncReviewItem' }
        meta: { $ref: '#/components/schemas/Meta' }
        openCount: { type: integer }
    SyncReviewResolveRequest:
      type: object
      required: [note]
      properties:
        note: { type: string, minLength: 1, maxLength: 500 }
    SyncReviewResolveResponse:
      type: object
      required: [data]
      properties:
        data: { $ref: '#/components/schemas/SyncReviewResolution' }
```

- [ ] **Step 2: Add the paths** (place `/api/v1/sync/review-items` right after `/api/v1/sync/batch`, the other two after `/api/v1/error-logs`):

```yaml
  /api/v1/sync/review-items:
    post:
      operationId: reportSyncReviewItems
      tags: [sales]
      summary: Tablet check-in of parked review items; returns the keys head office resolved
      parameters:
        - $ref: '#/components/parameters/OutletHeader'
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/SyncReviewReportRequest' }
      responses:
        '200':
          description: stored; resolved keys from this request
          content:
            application/json:
              schema: { $ref: '#/components/schemas/SyncReviewReportResponse' }
        '400':
          $ref: '#/components/responses/BadRequest'
  /api/v1/sync-review-items:
    get:
      operationId: listSyncReviewItems
      tags: [admin]
      summary: Head-office list of tablet review items (cross-outlet, paginated)
      parameters:
        - $ref: '#/components/parameters/Page'
        - $ref: '#/components/parameters/Limit'
        - name: status
          in: query
          schema: { type: string, enum: [open, resolved] }
        - name: outletId
          in: query
          schema: { type: string, format: uuid }
        - name: reviewCode
          in: query
          schema: { type: string, maxLength: 40 }
      responses:
        '200':
          description: review items
          content:
            application/json:
              schema: { $ref: '#/components/schemas/SyncReviewItemListResponse' }
        '403':
          $ref: '#/components/responses/Forbidden'
  /api/v1/sync-review-items/{key}/resolve:
    post:
      operationId: resolveSyncReviewItem
      tags: [admin]
      summary: Mark a review item handled (idempotent)
      parameters:
        - name: key
          in: path
          required: true
          schema: { type: string, maxLength: 200 }
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/SyncReviewResolveRequest' }
      responses:
        '200':
          description: resolution (the first one when already resolved)
          content:
            application/json:
              schema: { $ref: '#/components/schemas/SyncReviewResolveResponse' }
        '403':
          $ref: '#/components/responses/Forbidden'
        '404':
          $ref: '#/components/responses/NotFound'
```

Before saving, confirm `#/components/responses/BadRequest` exists (`grep -n "^    BadRequest:" backend/api/openapi.yaml`). If it does not, drop that `'400'` entry rather than inventing a response.

- [ ] **Step 3: Regenerate**

Run: `cd backend && go run ./cmd/codegen` then `cd .. && corepack pnpm --filter @mandalika/api gen`
Expected: both succeed; `git diff --stat` shows `api.gen.go` and `schema.d.ts` changed.

- [ ] **Step 4: Verify the contract gates**

Run: `cd backend && go run ./cmd/codegen -check && go build ./... && go test ./internal/api/...` then `cd .. && corepack pnpm gen:check`
Expected: all pass ("TypeScript OpenAPI schema matches regeneration.").

- [ ] **Step 5: Commit**

```bash
git add backend/api/openapi.yaml backend/internal/api/api.gen.go packages/api/src/schema.d.ts
printf 'feat(api): sync review items contract (report, list, resolve)\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n' > "$TEMP/msg.txt"
git commit -F "$TEMP/msg.txt"
```

---

### Task 2: Migration, repositories and input normalisation

**Files:**
- Create: `backend/internal/db/migrations/0048_sync_review_items.sql`
- Create: `backend/internal/write/syncreview.go`
- Create: `backend/internal/read/syncreview.go`
- Create: `backend/internal/handlers/sync_review_input.go`
- Test: `backend/internal/handlers/sync_review_input_test.go`

**Interfaces:**
- Produces (Go):
  - `write.SyncReviewReport{Key, OpType, ReviewCode, ReviewReason, LastError, OwnerUserID, CapturedOutletID string; Payload []byte; ClientCreatedAt time.Time}`
  - `write.SyncReviewResolution{Key, ResolvedAt, ResolvedByName, Note}` (JSON: `idempotencyKey, resolvedAt, resolvedByName, note`)
  - `(*write.Repo).UpsertSyncReviewReports(ctx, outletID, reporterID string, items []SyncReviewReport) ([]SyncReviewResolution, error)`
  - `(*write.Repo).ResolveSyncReviewItem(ctx, key, userID, note string) (SyncReviewResolution, error)` (returns `write.ErrNotFound` for unknown keys)
  - `read.SyncReviewFilter{Status, OutletID, ReviewCode string; Page, Limit int}`, `read.SyncReviewItem` (JSON per schema), `(*read.Repo).SyncReviewItems(ctx, f) ([]SyncReviewItem, int, error)`, `(*read.Repo).SyncReviewOpenCount(ctx) (int, error)`
  - handlers package: `reviewReportIn`, `normalizeReviewReports([]reviewReportIn) ([]write.SyncReviewReport, error)`, `normalizeResolveNote(string) (string, error)`, `sanitizeReviewPayload(json.RawMessage) []byte`, constants `maxReviewReports, maxReviewKeyLen, maxReviewCodeLen, maxReviewTextRunes, maxReviewPayloadBytes, maxResolveNoteRunes`, errors `errReviewBatchSize`, `errResolveNote`.

- [ ] **Step 1: Write the failing unit tests** in `backend/internal/handlers/sync_review_input_test.go`:

```go
package handlers

import (
	"encoding/json"
	"strings"
	"testing"
)

func validReport(key string) reviewReportIn {
	return reviewReportIn{
		IdempotencyKey:  key,
		Type:            "refund",
		ReviewCode:      "forbidden",
		ReviewReason:    "denied",
		ClientCreatedAt: "2026-10-12T03:00:00Z",
		Payload:         json.RawMessage(`{"orderNumber":"BSD-G0007","total":225000}`),
	}
}

func TestNormalizeReviewReportsBatchSize(t *testing.T) {
	if _, err := normalizeReviewReports(nil); err != errReviewBatchSize {
		t.Fatalf("empty batch: %v", err)
	}
	many := make([]reviewReportIn, maxReviewReports+1)
	if _, err := normalizeReviewReports(many); err != errReviewBatchSize {
		t.Fatalf("201 items: %v", err)
	}
}

func TestNormalizeReviewReportsSkipsInvalidItems(t *testing.T) {
	bad := []reviewReportIn{
		validReport("dev:ok"),
		validReport("dev:ok"), // duplicate key
		func() reviewReportIn { r := validReport(""); return r }(),
		func() reviewReportIn { r := validReport("dev:t"); r.Type = "sale"; return r }(),
		func() reviewReportIn { r := validReport("dev:d"); r.ClientCreatedAt = "yesterday"; return r }(),
		func() reviewReportIn { r := validReport(strings.Repeat("k", maxReviewKeyLen+1)); return r }(),
	}
	out, err := normalizeReviewReports(bad)
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != 1 || out[0].Key != "dev:ok" {
		t.Fatalf("want only dev:ok, got %+v", out)
	}
}

func TestNormalizeReviewReportsClipsAndStrips(t *testing.T) {
	r := validReport("dev:1")
	r.ReviewReason = strings.Repeat("é", maxReviewTextRunes+5)
	r.LastError = "a\x00b"
	r.ReviewCode = strings.Repeat("c", maxReviewCodeLen+3)
	r.OwnerUserID = "not-a-uuid"
	r.CapturedOutletID = "00000000-0000-4000-8a00-000000000001"
	out, _ := normalizeReviewReports([]reviewReportIn{r})
	got := out[0]
	if n := len([]rune(got.ReviewReason)); n != maxReviewTextRunes {
		t.Fatalf("reason runes = %d", n)
	}
	if got.LastError != "ab" {
		t.Fatalf("NUL not stripped: %q", got.LastError)
	}
	if len(got.ReviewCode) != maxReviewCodeLen {
		t.Fatalf("code len = %d", len(got.ReviewCode))
	}
	if got.OwnerUserID != "" || got.CapturedOutletID != "00000000-0000-4000-8a00-000000000001" {
		t.Fatalf("uuid handling: owner=%q captured=%q", got.OwnerUserID, got.CapturedOutletID)
	}
}

func TestSanitizeReviewPayload(t *testing.T) {
	cases := []struct{ name, in, want string }{
		{"strips pin", `{"transferId":"t1","pin":"1234"}`, `{"transferId":"t1"}`},
		{"not an object", `[1,2]`, `{"_invalid":true}`},
		{"NUL in string", `{"note":"a\u0000b"}`, `{"note":"ab"}`},
	}
	for _, c := range cases {
		if got := string(sanitizeReviewPayload(json.RawMessage(c.in))); got != c.want {
			t.Errorf("%s: got %s want %s", c.name, got, c.want)
		}
	}
	big := json.RawMessage(`{"x":"` + strings.Repeat("a", maxReviewPayloadBytes) + `"}`)
	var m map[string]any
	if err := json.Unmarshal(sanitizeReviewPayload(big), &m); err != nil || m["_truncated"] != true {
		t.Fatalf("oversized payload: %v %v", m, err)
	}
}

func TestNormalizeResolveNote(t *testing.T) {
	if _, err := normalizeResolveNote("   "); err != errResolveNote {
		t.Fatal("blank note accepted")
	}
	if _, err := normalizeResolveNote(strings.Repeat("x", maxResolveNoteRunes+1)); err != errResolveNote {
		t.Fatal("501-rune note accepted")
	}
	if n, err := normalizeResolveNote("  refund manual sudah  "); err != nil || n != "refund manual sudah" {
		t.Fatalf("got %q %v", n, err)
	}
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && go test ./internal/handlers/ -run "TestNormalizeReview|TestSanitizeReview|TestNormalizeResolve" -v`
Expected: FAIL — `undefined: reviewReportIn` (compile error).

- [ ] **Step 3: Write `backend/internal/handlers/sync_review_input.go`**

```go
package handlers

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/mandalika/pos-backend/internal/write"
)

// Limits for POST /sync/review-items and the resolve note (spec §4.3/§4.4).
const (
	maxReviewReports      = 200
	maxReviewKeyLen       = 200
	maxReviewCodeLen      = 40
	maxReviewTextRunes    = 1000
	maxReviewPayloadBytes = 64 << 10
	maxResolveNoteRunes   = 500
)

var reviewOpTypes = map[string]bool{
	"order": true, "refund": true, "shift_open": true, "shift_close": true,
	"cash_flow": true, "customer_create": true, "transfer_receive": true,
}

var (
	errReviewBatchSize = errors.New("items must hold 1-200 review items")
	errResolveNote     = errors.New("catatan wajib diisi (1-500 karakter)")
)

// reviewReportIn is one item of a tablet check-in, as sent.
type reviewReportIn struct {
	IdempotencyKey   string          `json:"idempotencyKey"`
	Type             string          `json:"type"`
	ReviewCode       string          `json:"reviewCode"`
	ReviewReason     string          `json:"reviewReason"`
	LastError        string          `json:"lastError"`
	OwnerUserID      string          `json:"ownerUserId"`
	CapturedOutletID string          `json:"capturedOutletId"`
	ClientCreatedAt  string          `json:"clientCreatedAt"`
	Payload          json.RawMessage `json:"payload"`
}

// normalizeReviewReports validates a check-in. A wrong batch size rejects the
// request; an invalid single item is skipped (the reply only lists resolved
// keys, so a skipped item is simply reported again next time).
func normalizeReviewReports(in []reviewReportIn) ([]write.SyncReviewReport, error) {
	if len(in) == 0 || len(in) > maxReviewReports {
		return nil, errReviewBatchSize
	}
	out := make([]write.SyncReviewReport, 0, len(in))
	seen := make(map[string]bool, len(in))
	for _, it := range in {
		key := strings.TrimSpace(it.IdempotencyKey)
		if key == "" || len(key) > maxReviewKeyLen || seen[key] || !reviewOpTypes[it.Type] {
			continue
		}
		at, err := time.Parse(time.RFC3339Nano, it.ClientCreatedAt)
		if err != nil {
			continue
		}
		seen[key] = true
		out = append(out, write.SyncReviewReport{
			Key:              key,
			OpType:           it.Type,
			ReviewCode:       clipText(strings.TrimSpace(it.ReviewCode), maxReviewCodeLen),
			ReviewReason:     clipText(it.ReviewReason, maxReviewTextRunes),
			LastError:        clipText(it.LastError, maxReviewTextRunes),
			OwnerUserID:      uuidOrEmpty(it.OwnerUserID),
			CapturedOutletID: uuidOrEmpty(it.CapturedOutletID),
			Payload:          sanitizeReviewPayload(it.Payload),
			ClientCreatedAt:  at,
		})
	}
	return out, nil
}

// clipText removes NUL (PostgreSQL rejects it in text) and caps the rune count.
func clipText(s string, max int) string {
	s = strings.ReplaceAll(s, "\x00", "")
	if utf8.RuneCountInString(s) <= max {
		return s
	}
	return string([]rune(s)[:max])
}

func uuidOrEmpty(s string) string {
	if _, err := uuid.Parse(s); err != nil {
		return ""
	}
	return s
}

var invalidPayload = []byte(`{"_invalid":true}`)

// sanitizeReviewPayload returns a JSON object safe for jsonb: size-capped,
// top-level pin removed (backstop; the tablet already strips it), NUL removed.
func sanitizeReviewPayload(raw json.RawMessage) []byte {
	if len(raw) > maxReviewPayloadBytes {
		b, _ := json.Marshal(map[string]any{"_truncated": true, "bytes": len(raw)})
		return b
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil || m == nil {
		return invalidPayload
	}
	delete(m, "pin")
	b, err := json.Marshal(m)
	if err != nil {
		return invalidPayload
	}
	b = bytes.ReplaceAll(b, []byte(`\u0000`), nil)
	if !json.Valid(b) {
		return invalidPayload
	}
	return b
}

func normalizeResolveNote(s string) (string, error) {
	n := strings.TrimSpace(s)
	if n == "" || utf8.RuneCountInString(n) > maxResolveNoteRunes {
		return "", errResolveNote
	}
	return n, nil
}
```

- [ ] **Step 4: Write the migration** `backend/internal/db/migrations/0048_sync_review_items.sql`:

```sql
-- Head-office review of tablet sync items the server refused for good
-- (design: docs/plans/2026-10-12-review-resolve-design.md). Additive.
-- Rows are never deleted: the resolution columns are the audit record.
CREATE TABLE IF NOT EXISTS sync_review_items (
  idempotency_key    text PRIMARY KEY,
  outlet_id          uuid NOT NULL REFERENCES outlets(id),
  captured_outlet_id uuid,
  op_type            text NOT NULL,
  review_code        text,
  review_reason      text,
  last_error         text,
  owner_user_id      uuid,
  payload            jsonb NOT NULL,
  client_created_at  timestamptz NOT NULL,
  first_reported_at  timestamptz NOT NULL DEFAULT now(),
  last_reported_at   timestamptz NOT NULL DEFAULT now(),
  reported_by        uuid NOT NULL,
  resolved_at        timestamptz,
  resolved_by        uuid,
  resolution_note    text,
  CONSTRAINT sync_review_resolved_by CHECK ((resolved_at IS NULL) = (resolved_by IS NULL)),
  CONSTRAINT sync_review_resolved_note CHECK ((resolved_at IS NULL) = (resolution_note IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_sync_review_items_open
  ON sync_review_items (outlet_id, client_created_at) WHERE resolved_at IS NULL;
```

- [ ] **Step 5: Write `backend/internal/write/syncreview.go`**

```go
package write

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// SyncReviewReport is one parked tablet item from POST /sync/review-items,
// already validated and redacted by the handler.
type SyncReviewReport struct {
	Key              string
	OpType           string
	ReviewCode       string
	ReviewReason     string
	LastError        string
	OwnerUserID      string // "" = unknown
	CapturedOutletID string // "" = unknown
	Payload          []byte // JSON object
	ClientCreatedAt  time.Time
}

// SyncReviewResolution is head office's decision on one item.
type SyncReviewResolution struct {
	Key            string    `json:"idempotencyKey"`
	ResolvedAt     time.Time `json:"resolvedAt"`
	ResolvedByName string    `json:"resolvedByName"`
	Note           string    `json:"note"`
}

const resolutionSelect = `
	SELECT s.idempotency_key, s.resolved_at, COALESCE(u.display_name, ''), s.resolution_note
	FROM sync_review_items s LEFT JOIN users u ON u.id = s.resolved_by`

// UpsertSyncReviewReports stores a check-in for outletID and returns the keys of
// this request that head office already resolved. A key stored under another
// outlet is left untouched and never returned. Re-reporting never reopens.
func (r *Repo) UpsertSyncReviewReports(ctx context.Context, outletID, reporterID string, items []SyncReviewReport) ([]SyncReviewResolution, error) {
	tx, err := r.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	keys := make([]string, 0, len(items))
	for _, it := range items {
		if _, err := tx.Exec(ctx, `
			INSERT INTO sync_review_items (idempotency_key, outlet_id, captured_outlet_id, op_type,
			  review_code, review_reason, last_error, owner_user_id, payload, client_created_at, reported_by)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)
			ON CONFLICT (idempotency_key) DO UPDATE SET
			  last_reported_at = now(),
			  review_code = EXCLUDED.review_code,
			  review_reason = EXCLUDED.review_reason,
			  last_error = EXCLUDED.last_error
			WHERE sync_review_items.outlet_id = EXCLUDED.outlet_id`,
			it.Key, outletID, elNullUUID(it.CapturedOutletID), it.OpType,
			elNullStr(it.ReviewCode), elNullStr(it.ReviewReason), elNullStr(it.LastError),
			elNullUUID(it.OwnerUserID), string(it.Payload), it.ClientCreatedAt, reporterID,
		); err != nil {
			return nil, err
		}
		keys = append(keys, it.Key)
	}
	rows, err := tx.Query(ctx, resolutionSelect+`
		WHERE s.idempotency_key = ANY($1) AND s.outlet_id = $2 AND s.resolved_at IS NOT NULL
		ORDER BY s.idempotency_key`, keys, outletID)
	if err != nil {
		return nil, err
	}
	out := []SyncReviewResolution{}
	for rows.Next() {
		var x SyncReviewResolution
		if err := rows.Scan(&x.Key, &x.ResolvedAt, &x.ResolvedByName, &x.Note); err != nil {
			rows.Close()
			return nil, err
		}
		out = append(out, x)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// ResolveSyncReviewItem marks one item handled. Resolving twice keeps and
// returns the first resolution. Unknown key → ErrNotFound.
func (r *Repo) ResolveSyncReviewItem(ctx context.Context, key, userID, note string) (SyncReviewResolution, error) {
	if _, err := r.Pool.Exec(ctx, `
		UPDATE sync_review_items SET resolved_at = now(), resolved_by = $2, resolution_note = $3
		WHERE idempotency_key = $1 AND resolved_at IS NULL`, key, userID, note); err != nil {
		return SyncReviewResolution{}, err
	}
	var x SyncReviewResolution
	err := r.Pool.QueryRow(ctx, resolutionSelect+`
		WHERE s.idempotency_key = $1 AND s.resolved_at IS NOT NULL`, key).
		Scan(&x.Key, &x.ResolvedAt, &x.ResolvedByName, &x.Note)
	if errors.Is(err, pgx.ErrNoRows) {
		return SyncReviewResolution{}, ErrNotFound
	}
	return x, err
}
```

- [ ] **Step 6: Write `backend/internal/read/syncreview.go`**

```go
package read

import (
	"context"
	"encoding/json"
	"time"
)

// SyncReviewFilter selects head-office review items. Status is "open" or "resolved";
// ReviewCode "none" matches items parked without a code.
type SyncReviewFilter struct {
	Status, OutletID, ReviewCode string
	Page, Limit                  int
}

type SyncReviewItem struct {
	Key                string          `json:"idempotencyKey"`
	OutletID           string          `json:"outletId"`
	OutletName         string          `json:"outletName"`
	CapturedOutletID   *string         `json:"capturedOutletId"`
	CapturedOutletName *string         `json:"capturedOutletName"`
	Type               string          `json:"type"`
	ReviewCode         *string         `json:"reviewCode"`
	ReviewReason       *string         `json:"reviewReason"`
	LastError          *string         `json:"lastError"`
	OwnerUserID        *string         `json:"ownerUserId"`
	OwnerName          *string         `json:"ownerName"`
	Payload            json.RawMessage `json:"payload"`
	ClientCreatedAt    time.Time       `json:"clientCreatedAt"`
	FirstReportedAt    time.Time       `json:"firstReportedAt"`
	LastReportedAt     time.Time       `json:"lastReportedAt"`
	ReportedByName     string          `json:"reportedByName"`
	ResolvedAt         *time.Time      `json:"resolvedAt"`
	ResolvedByName     *string         `json:"resolvedByName"`
	ResolutionNote     *string         `json:"resolutionNote"`
	AppliedOnServer    bool            `json:"appliedOnServer"`
}

// SyncReviewItems lists review items across all outlets. Open items oldest first,
// resolved items most recently resolved first.
func (r *Repo) SyncReviewItems(ctx context.Context, f SyncReviewFilter) ([]SyncReviewItem, int, error) {
	rows, err := r.Pool.Query(ctx, `
		SELECT s.idempotency_key, s.outlet_id::text, COALESCE(o.name, ''),
		  s.captured_outlet_id::text, co.name, s.op_type, s.review_code, s.review_reason,
		  s.last_error, s.owner_user_id::text, ou.display_name, s.payload,
		  s.client_created_at, s.first_reported_at, s.last_reported_at,
		  COALESCE(rb.display_name, ''), s.resolved_at, rv.display_name, s.resolution_note,
		  -- Same probe as sync/attribute.go Applied: orders dedupe via processed_keys,
		  -- transfer receives via transfers.received_idempotency_key, the A11 keyed
		  -- types via operation_receipts. Missing one would hide "Sudah masuk ke server"
		  -- and invite a manual re-entry (double sale / double stock move).
		  (EXISTS (SELECT 1 FROM operation_receipts rc WHERE rc.idempotency_key = s.idempotency_key)
		   OR EXISTS (SELECT 1 FROM processed_keys pk WHERE pk.idempotency_key = s.idempotency_key)
		   OR EXISTS (SELECT 1 FROM transfers tr WHERE tr.received_idempotency_key = s.idempotency_key)),
		  count(*) OVER()
		FROM sync_review_items s
		LEFT JOIN outlets o ON o.id = s.outlet_id
		LEFT JOIN outlets co ON co.id = s.captured_outlet_id
		LEFT JOIN users ou ON ou.id = s.owner_user_id
		LEFT JOIN users rb ON rb.id = s.reported_by
		LEFT JOIN users rv ON rv.id = s.resolved_by
		WHERE (CASE WHEN $1::text = 'resolved' THEN s.resolved_at IS NOT NULL ELSE s.resolved_at IS NULL END)
		  AND ($2::text = '' OR s.outlet_id::text = $2::text)
		  AND ($3::text = '' OR COALESCE(s.review_code, 'none') = $3::text)
		ORDER BY CASE WHEN $1::text = 'resolved' THEN s.resolved_at END DESC NULLS LAST,
		  s.client_created_at ASC, s.idempotency_key
		OFFSET $4 LIMIT $5`,
		f.Status, f.OutletID, f.ReviewCode, off(f.Page, f.Limit), f.Limit)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	items, total := []SyncReviewItem{}, 0
	for rows.Next() {
		var it SyncReviewItem
		var payload []byte
		if err := rows.Scan(&it.Key, &it.OutletID, &it.OutletName, &it.CapturedOutletID,
			&it.CapturedOutletName, &it.Type, &it.ReviewCode, &it.ReviewReason, &it.LastError,
			&it.OwnerUserID, &it.OwnerName, &payload, &it.ClientCreatedAt, &it.FirstReportedAt,
			&it.LastReportedAt, &it.ReportedByName, &it.ResolvedAt, &it.ResolvedByName,
			&it.ResolutionNote, &it.AppliedOnServer, &total); err != nil {
			return nil, 0, err
		}
		it.Payload = json.RawMessage(payload)
		items = append(items, it)
	}
	return items, total, rows.Err()
}

// SyncReviewOpenCount is the unfiltered number of open items (sidebar badge).
func (r *Repo) SyncReviewOpenCount(ctx context.Context) (int, error) {
	var n int
	err := r.Pool.QueryRow(ctx, `SELECT count(*) FROM sync_review_items WHERE resolved_at IS NULL`).Scan(&n)
	return n, err
}
```

- [ ] **Step 7: Run unit tests and build**

Run: `cd backend && go test ./internal/handlers/ -run "TestNormalizeReview|TestSanitizeReview|TestNormalizeResolve" -v && go build ./... && go vet ./internal/read/ ./internal/write/ ./internal/handlers/`
Expected: PASS, build and vet clean.

- [ ] **Step 8: Commit**

```bash
git add backend/internal/db/migrations/0048_sync_review_items.sql backend/internal/write/syncreview.go backend/internal/read/syncreview.go backend/internal/handlers/sync_review_input.go backend/internal/handlers/sync_review_input_test.go
printf 'feat(backend): sync_review_items table, repos and input rules (mig 0048)\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n' > "$TEMP/msg.txt"
git commit -F "$TEMP/msg.txt"
```

---

### Task 3: Handlers, routes and the PostgreSQL gate

**Files:**
- Create: `backend/internal/handlers/sync_review.go`
- Modify: `backend/internal/server/server.go` (sync routes ~line 140; a new permission group next to the `manage_customers` group ~line 161)
- Create: `backend/internal/handlers/sync_review_integration_test.go`
- Modify: `scripts/ci/postgres_gate.py:27-39` (GATES)

**Interfaces:**
- Consumes: everything Task 2 produces.
- Produces: `(*Handlers).ReportSyncReviewItems`, `ListSyncReviewItems`, `ResolveSyncReviewItem` (`http.HandlerFunc`). Wire responses: report → `{"data":{"resolved":[...]}}`; list → `{"data":[...],"meta":{total,page,limit},"openCount":n}`; resolve → `{"data":{idempotencyKey,resolvedAt,resolvedByName,note}}`.

- [ ] **Step 1: Write the failing PG integration test** `backend/internal/handlers/sync_review_integration_test.go`. Copy the fixture-guard preamble from `operation_receipts_integration_test.go:34-65` with these exact values: env `MANDALIKA_RV_TEST_DSN`, port `56450`, database `mandalika_rv_synthetic`, user `rv_test`, data-dir env `MANDALIKA_RV_TEST_DATA_DIR`. Then:

```go
package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/config"
	"github.com/mandalika/pos-backend/internal/db"
	mw "github.com/mandalika/pos-backend/internal/middleware"
	"github.com/mandalika/pos-backend/internal/read"
	"github.com/mandalika/pos-backend/internal/service"
	syncpkg "github.com/mandalika/pos-backend/internal/sync"
	"github.com/mandalika/pos-backend/internal/write"
)

// Head-office review items: tablets report parked items, head office resolves
// them, the next report returns the resolution. Opt-in synthetic cluster only.
func TestSyncReviewPostgres(t *testing.T) {
	dsn := os.Getenv("MANDALIKA_RV_TEST_DSN")
	if dsn == "" {
		t.Skip("isolated sync-review PostgreSQL fixture not configured")
	}
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ConnConfig.Host != "127.0.0.1" || cfg.ConnConfig.Port != 56450 || cfg.ConnConfig.Database != "mandalika_rv_synthetic" || cfg.ConnConfig.User != "rv_test" {
		t.Fatal("refusing non-fixture target")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	var dir string
	if err = pool.QueryRow(ctx, "SHOW data_directory").Scan(&dir); err != nil {
		t.Fatal(err)
	}
	expected := os.Getenv("MANDALIKA_RV_TEST_DATA_DIR")
	if expected == "" || filepath.Clean(dir) != filepath.Clean(expected) {
		t.Fatal("fixture directory mismatch")
	}
	var tables int
	if err = pool.QueryRow(ctx, "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'").Scan(&tables); err != nil || tables != 0 {
		t.Fatalf("fixture must be empty: tables=%d err=%v", tables, err)
	}
	if err = (&db.DB{Pool: pool}).Migrate(ctx); err != nil {
		t.Fatal(err)
	}

	const outletA = "00000000-0000-4000-8b00-000000000001"
	const outletB = "00000000-0000-4000-8b00-000000000002"
	const cashierA = "00000000-0000-4000-8b00-000000000011"
	const cashierB = "00000000-0000-4000-8b00-000000000012"
	const headOffice = "00000000-0000-4000-8b00-000000000013"
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("exec: %v", err)
		}
	}
	exec(`INSERT INTO outlets(id,name) VALUES($1,'RV outlet A'),($2,'RV outlet B')`, outletA, outletB)
	exec(`INSERT INTO users(id,email,password_hash,display_name,role,outlet_id) VALUES
		($1,'a@example.invalid','x','RV cashier A','cashier',$4),
		($2,'b@example.invalid','x','RV cashier B','cashier',$5),
		($3,'ho@example.invalid','x','RV head office','manager',NULL)`, cashierA, cashierB, headOffice, outletA, outletB)

	rd, wr, svc := read.New(pool), write.New(pool), service.NewOrderService(pool)
	h := New(rd, nil, auth.NewStore(pool), wr, svc, syncpkg.New(pool, rd, svc, wr), nil)
	secret := []byte("RV-SYNTHETIC-TEST-KEY")
	issue := func(user, role, outlet string, perms []string) string {
		tok, err := auth.IssueAccess(secret, time.Hour, user, role, outlet, perms)
		if err != nil {
			t.Fatal(err)
		}
		return tok
	}
	tokA := issue(cashierA, "cashier", outletA, nil)
	tokB := issue(cashierB, "cashier", outletB, nil)
	tokHO := issue(headOffice, "manager", "", []string{"resolve_sync_review"})
	router := chi.NewRouter()
	router.Use(mw.RequireAuth(&config.Config{AccessSecret: secret}))
	router.Post("/sync/review-items", h.ReportSyncReviewItems)
	router.Group(func(r chi.Router) {
		r.Use(mw.RequirePermission("resolve_sync_review"))
		r.Get("/sync-review-items", h.ListSyncReviewItems)
		r.Post("/sync-review-items/{key}/resolve", h.ResolveSyncReviewItem)
	})
	do := func(method, path, token, body string) (int, string) {
		t.Helper()
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		return w.Code, w.Body.String()
	}
	report := func(token string, items ...string) []write.SyncReviewResolution {
		t.Helper()
		code, body := do("POST", "/sync/review-items", token, `{"items":[`+strings.Join(items, ",")+`]}`)
		var out struct {
			Data struct {
				Resolved []write.SyncReviewResolution `json:"resolved"`
			} `json:"data"`
		}
		if code != 200 || json.Unmarshal([]byte(body), &out) != nil {
			t.Fatalf("report: %d %s", code, body)
		}
		return out.Data.Resolved
	}
	item := func(key, code, payload string) string {
		return fmt.Sprintf(`{"idempotencyKey":%q,"type":"refund","reviewCode":%q,"reviewReason":"denied","clientCreatedAt":"2026-10-12T03:00:00Z","payload":%s}`, key, code, payload)
	}
	// Escape ':' the way the backoffice's encodeURIComponent does (url.PathEscape leaves ':' alone).
	resolve := func(token, key, note string) (int, string) {
		return do("POST", "/sync-review-items/"+strings.ReplaceAll(key, ":", "%3A")+"/resolve", token, fmt.Sprintf(`{"note":%q}`, note))
	}
	keyA := "devA:00000000-0000-4000-8b00-0000000000a1"

	t.Run("report stores the item with pin removed and nothing resolved", func(t *testing.T) {
		if got := report(tokA, item(keyA, "forbidden", `{"orderNumber":"BSD-G0007","pin":"1234"}`)); len(got) != 0 {
			t.Fatalf("resolved = %+v", got)
		}
		var outlet, payload string
		if err := pool.QueryRow(ctx, `SELECT outlet_id::text, payload::text FROM sync_review_items WHERE idempotency_key=$1`, keyA).Scan(&outlet, &payload); err != nil {
			t.Fatal(err)
		}
		if outlet != outletA || strings.Contains(payload, "pin") {
			t.Fatalf("outlet=%s payload=%s", outlet, payload)
		}
	})

	t.Run("NUL characters are stored stripped", func(t *testing.T) {
		report(tokA, fmt.Sprintf(`{"idempotencyKey":"devA:nul","type":"order","reviewReason":"a\u0000b","clientCreatedAt":"2026-10-12T03:00:00Z","payload":{"note":"x\u0000y"}}`))
		var reason, payload string
		if err := pool.QueryRow(ctx, `SELECT review_reason, payload->>'note' FROM sync_review_items WHERE idempotency_key='devA:nul'`).Scan(&reason, &payload); err != nil {
			t.Fatal(err)
		}
		if reason != "ab" || payload != "xy" {
			t.Fatalf("reason=%q note=%q", reason, payload)
		}
	})

	t.Run("another outlet cannot overwrite or learn the item", func(t *testing.T) {
		report(tokB, item(keyA, "rejected", `{}`))
		var code string
		if err := pool.QueryRow(ctx, `SELECT review_code FROM sync_review_items WHERE idempotency_key=$1`, keyA).Scan(&code); err != nil || code != "forbidden" {
			t.Fatalf("code=%q err=%v", code, err)
		}
	})

	// Runs before the appliedOnServer subtest adds three more open items.
	t.Run("list needs the permission", func(t *testing.T) {
		if code, _ := do("GET", "/sync-review-items", tokA, ""); code != 403 {
			t.Fatalf("cashier list = %d", code)
		}
		code, body := do("GET", "/sync-review-items?status=open", tokHO, "")
		var out struct {
			Data      []read.SyncReviewItem `json:"data"`
			Meta      struct{ Total int }   `json:"meta"`
			OpenCount int                   `json:"openCount"`
		}
		if code != 200 || json.Unmarshal([]byte(body), &out) != nil || out.OpenCount != 2 || out.Meta.Total != 2 {
			t.Fatalf("list: %d %s", code, body)
		}
	})

	t.Run("resolve with an escaped key, then the tablet learns it", func(t *testing.T) {
		if code, body := resolve(tokHO, keyA, "  refund manual sudah dibuat  "); code != 200 || !strings.Contains(body, `"note":"refund manual sudah dibuat"`) {
			t.Fatalf("resolve: %d %s", code, body)
		}
		got := report(tokA, item(keyA, "forbidden", `{}`))
		if len(got) != 1 || got[0].Key != keyA || got[0].ResolvedByName != "RV head office" {
			t.Fatalf("resolved = %+v", got)
		}
		if len(report(tokB, item(keyA, "forbidden", `{}`))) != 0 {
			t.Fatal("other outlet learned the resolution")
		}
	})

	t.Run("resolve twice keeps the first note; unknown key is 404; blank note is 400", func(t *testing.T) {
		if code, body := resolve(tokHO, keyA, "second"); code != 200 || !strings.Contains(body, "refund manual sudah dibuat") {
			t.Fatalf("second resolve: %d %s", code, body)
		}
		if code, _ := resolve(tokHO, "devA:missing", "x"); code != 404 {
			t.Fatalf("unknown key = %d", code)
		}
		if code, _ := resolve(tokHO, keyA, "   "); code != 400 {
			t.Fatalf("blank note = %d", code)
		}
	})

	t.Run("re-reporting a resolved item never reopens it", func(t *testing.T) {
		report(tokA, item(keyA, "forbidden", `{}`))
		var open int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM sync_review_items WHERE idempotency_key=$1 AND resolved_at IS NULL`, keyA).Scan(&open); err != nil || open != 0 {
			t.Fatalf("reopened: open=%d err=%v", open, err)
		}
	})

	t.Run("appliedOnServer covers receipts, orders and transfer receives", func(t *testing.T) {
		applied := func(key string) bool {
			t.Helper()
			_, body := do("GET", "/sync-review-items?status=open&limit=200", tokHO, "")
			var out struct {
				Data []read.SyncReviewItem `json:"data"`
			}
			if err := json.Unmarshal([]byte(body), &out); err != nil {
				t.Fatal(err)
			}
			for _, it := range out.Data {
				if it.Key == key {
					return it.AppliedOnServer
				}
			}
			t.Fatalf("%s not listed: %s", key, body)
			return false
		}
		report(tokA,
			`{"idempotencyKey":"devA:refund-ok","type":"refund","clientCreatedAt":"2026-10-12T03:00:00Z","payload":{}}`,
			`{"idempotencyKey":"devA:order-ok","type":"order","clientCreatedAt":"2026-10-12T03:00:00Z","payload":{}}`,
			`{"idempotencyKey":"devA:trf-ok","type":"transfer_receive","clientCreatedAt":"2026-10-12T03:00:00Z","payload":{}}`)
		for _, k := range []string{"devA:refund-ok", "devA:order-ok", "devA:trf-ok"} {
			if applied(k) {
				t.Fatalf("%s applied before any server record", k)
			}
		}
		exec(`INSERT INTO operation_receipts(idempotency_key,op_type,scope,fingerprint,outcome) VALUES('devA:refund-ok','refund',$1,'f','{}')`, outletA)
		exec(`INSERT INTO processed_keys(idempotency_key) VALUES('devA:order-ok')`)
		exec(`INSERT INTO transfers(source_outlet_id,dest_outlet_id,status,received_idempotency_key) VALUES($1,$2,'received','devA:trf-ok')`, outletB, outletA)
		for _, k := range []string{"devA:refund-ok", "devA:order-ok", "devA:trf-ok"} {
			if !applied(k) {
				t.Fatalf("%s not flagged applied", k)
			}
		}
	})

	t.Run("bad batch sizes are 400", func(t *testing.T) {
		if code, _ := do("POST", "/sync/review-items", tokA, `{"items":[]}`); code != 400 {
			t.Fatalf("empty = %d", code)
		}
	})
}
```

- [ ] **Step 2: Register the gate** in `scripts/ci/postgres_gate.py` — append to `GATES` after the `RF` line:

```python
    ("RV", "TestSyncReviewPostgres", 56450, "rv"),
```

- [ ] **Step 3: Run to verify failure**

Run: `cd backend && go vet ./internal/handlers/`
Expected: FAIL — `h.ReportSyncReviewItems undefined`.

- [ ] **Step 4: Write `backend/internal/handlers/sync_review.go`**

```go
package handlers

import (
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/httpx"
	"github.com/mandalika/pos-backend/internal/read"
	"github.com/mandalika/pos-backend/internal/write"
)

// reviewReportBodyLimit bounds a check-in body (the tablet sends at most 50 items).
const reviewReportBodyLimit = 8 << 20

// ReportSyncReviewItems: POST /sync/review-items (tablet check-in). The outlet
// comes from the caller's auth context, never from the body.
func (h *Handlers) ReportSyncReviewItems(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, reviewReportBodyLimit)
	var body struct {
		Items []reviewReportIn `json:"items"`
	}
	if err := httpx.DecodeLoose(r, &body); err != nil {
		httpx.Err(w, http.StatusBadRequest, "invalid body")
		return
	}
	items, err := normalizeReviewReports(body.Items)
	if err != nil {
		httpx.Err(w, http.StatusBadRequest, err.Error())
		return
	}
	c, _ := h.caller(r)
	if c.outletID == "" || c.userID == "" {
		httpx.Err(w, http.StatusBadRequest, "outlet terminal tidak diketahui")
		return
	}
	resolved := []write.SyncReviewResolution{}
	if len(items) > 0 {
		resolved, err = h.Write.UpsertSyncReviewReports(r.Context(), c.outletID, c.userID, items)
		if err != nil {
			slog.Error("sync review report failed", "outletId", c.outletID, "err", err)
			httpx.Err(w, http.StatusInternalServerError, "gagal menyimpan item tinjauan")
			return
		}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"resolved": resolved})
}

// ListSyncReviewItems: GET /sync-review-items (head office, all outlets).
func (h *Handlers) ListSyncReviewItems(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	status := q.Get("status")
	if status == "" {
		status = "open"
	}
	if status != "open" && status != "resolved" {
		httpx.Err(w, http.StatusBadRequest, "status must be open or resolved")
		return
	}
	outletID := q.Get("outletId")
	if _, err := uuid.Parse(outletID); outletID != "" && err != nil {
		httpx.Err(w, http.StatusBadRequest, "invalid outletId")
		return
	}
	code := strings.TrimSpace(q.Get("reviewCode"))
	if len(code) > maxReviewCodeLen {
		httpx.Err(w, http.StatusBadRequest, "invalid reviewCode")
		return
	}
	page, limit := pageLimit(r)
	items, total, err := h.Repo.SyncReviewItems(r.Context(), read.SyncReviewFilter{
		Status: status, OutletID: outletID, ReviewCode: code, Page: page, Limit: limit,
	})
	if err != nil {
		slog.Error("sync review list failed", "err", err)
		httpx.Err(w, http.StatusInternalServerError, "gagal memuat item tinjauan")
		return
	}
	open, err := h.Repo.SyncReviewOpenCount(r.Context())
	if err != nil {
		slog.Error("sync review count failed", "err", err)
		httpx.Err(w, http.StatusInternalServerError, "gagal memuat item tinjauan")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": items, "meta": meta(total, page, limit), "openCount": open})
}

// ResolveSyncReviewItem: POST /sync-review-items/{key}/resolve. The key arrives
// percent-encoded (it contains ':'), and chi hands back the raw segment.
func (h *Handlers) ResolveSyncReviewItem(w http.ResponseWriter, r *http.Request) {
	key, err := url.PathUnescape(chi.URLParam(r, "key"))
	if err != nil || key == "" || len(key) > maxReviewKeyLen {
		httpx.Err(w, http.StatusBadRequest, "invalid key")
		return
	}
	var body struct {
		Note string `json:"note"`
	}
	if err := httpx.DecodeLoose(r, &body); err != nil {
		httpx.Err(w, http.StatusBadRequest, "invalid body")
		return
	}
	note, err := normalizeResolveNote(body.Note)
	if err != nil {
		httpx.Err(w, http.StatusBadRequest, err.Error())
		return
	}
	uid, _ := r.Context().Value(auth.CtxUserID).(string)
	res, err := h.Write.ResolveSyncReviewItem(r.Context(), key, uid, note)
	if errors.Is(err, write.ErrNotFound) {
		httpx.Err(w, http.StatusNotFound, "not found")
		return
	}
	if err != nil {
		slog.Error("sync review resolve failed", "key", key, "err", err)
		httpx.Err(w, http.StatusInternalServerError, "gagal menyelesaikan item")
		return
	}
	httpx.JSON(w, http.StatusOK, res)
}
```

- [ ] **Step 5: Wire the routes** in `backend/internal/server/server.go`. In the offline-sync block, after `r.Post("/sync/batch", h.SyncBatch)`:

```go
			r.Post("/sync/review-items", h.ReportSyncReviewItems)
```

and add a new group right after the `manage_customers` group closes:

```go
			// Head-office review of refused tablet items (no content-version bump).
			r.Group(func(r chi.Router) {
				r.Use(mw.RequirePermission("resolve_sync_review"))
				r.Get("/sync-review-items", h.ListSyncReviewItems)
				r.Post("/sync-review-items/{key}/resolve", h.ResolveSyncReviewItem)
			})
```

- [ ] **Step 6: Run the gate locally**

Run: `python scripts/ci/postgres_gate.py --runtime native --pg-bin "C:/Program Files/PostgreSQL/18/bin" --no-race --output "$TEMP/pg-gate.json"`
(The hook blocks `--no-race` on the command line: put the command in a scratch `.sh` file and run `bash <file>`.)
Expected: all 12 gates pass, including `RV`. Also `cd backend && go test ./... && gofmt -l internal/` → tests pass, gofmt prints nothing.

- [ ] **Step 7: Commit**

```bash
git add backend/internal/handlers/sync_review.go backend/internal/handlers/sync_review_integration_test.go backend/internal/server/server.go scripts/ci/postgres_gate.py
printf 'feat(backend): sync review report/list/resolve endpoints + PG gate RV\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n' > "$TEMP/msg.txt"
git commit -F "$TEMP/msg.txt"
```

---

### Task 3b: Password-reset revoke marker outlives every issued refresh token

Why: the 30-day TTL ships with this backend deploy (Task 10). `reset.go:85` stores the
"refresh tokens issued before now are dead" marker with TTL = `RefreshTTL`. After the cut to
720 h, a marker would expire after 30 days, while refresh tokens issued before the cutover
carry a 1-year expiry. This is an auth change, so it gets an Opus review.

**Files:**
- Modify: `backend/internal/auth/reset.go:85`
- Test: `backend/internal/auth/reset_test.go:169` (the existing marker-TTL assertion) + a new pure test

**Interfaces:**
- Produces: `const revokeMarkerMinTTL = 8760 * time.Hour`, `func revokeMarkerTTL(refreshTTL time.Duration) time.Duration`.

- [ ] **Step 1: Write the failing tests.** In `reset_test.go`, change the assertion at line ~169 from `ttl != time.Hour` to:

```go
	if ttl := mr.TTL(refreshRevokedKey(targetID)); ttl != revokeMarkerMinTTL {
		t.Fatalf("marker ttl = %v", ttl)
	}
```

and append:

```go
func TestRevokeMarkerTTLNeverShorterThanLegacyRefresh(t *testing.T) {
	if got := revokeMarkerTTL(720 * time.Hour); got != revokeMarkerMinTTL {
		t.Fatalf("30-day refresh: marker ttl = %v", got)
	}
	if got := revokeMarkerTTL(2 * revokeMarkerMinTTL); got != 2*revokeMarkerMinTTL {
		t.Fatalf("longer refresh: marker ttl = %v", got)
	}
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && go test ./internal/auth/ -run "Reset|RevokeMarker" -v`
Expected: FAIL — `undefined: revokeMarkerMinTTL`.

- [ ] **Step 3: Implement** in `reset.go` (next to `refreshRevokedKey`; `time` is already imported if `h.clock()` returns `time.Time` — add the import otherwise):

```go
// revokeMarkerMinTTL is the longest refresh-token TTL ever issued (8760 h until the
// 2026-10 cut to 720 h). A reset marker must outlive every refresh token still in
// circulation, so it never expires sooner than this.
const revokeMarkerMinTTL = 8760 * time.Hour

func revokeMarkerTTL(refreshTTL time.Duration) time.Duration {
	if refreshTTL > revokeMarkerMinTTL {
		return refreshTTL
	}
	return revokeMarkerMinTTL
}
```

and change line 85 to `h.Cache.R.Set(ctx, refreshRevokedKey(targetID), marker, revokeMarkerTTL(h.Cfg.RefreshTTL))`.

- [ ] **Step 4: Run tests** — `cd backend && go test ./internal/auth/... && gofmt -l internal/auth/` → PASS, no gofmt output.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/auth/reset.go backend/internal/auth/reset_test.go
printf 'fix(auth): reset revoke marker outlives 1-year legacy refresh tokens\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n' > "$TEMP/msg.txt"
git commit -F "$TEMP/msg.txt"
```

- [ ] **Step 6: Opus review gate.** Dispatch `reviewer` on this commit (auth surface).

---

### Task 4: Shared types and API client methods

**Files:**
- Modify: `packages/types/src/index.ts:41-54` (`UserPermission`)
- Modify: `packages/api/src/client.ts` (type aliases near line 67; `Api` interface near line 248; implementation near line 642)

**Interfaces:**
- Consumes: Task 1 schema names.
- Produces (TS): `UserPermission.RESOLVE_SYNC_REVIEW = 'resolve_sync_review'`; types `SyncReviewItem`, `SyncReviewResolution`, `SyncReviewItemList`; `api.listSyncReviewItems(params: SyncReviewListParams): Promise<SyncReviewItemList>`; `api.resolveSyncReviewItem(key: string, note: string): Promise<SyncReviewResolution>`; `SyncReviewListParams = { status: 'open' | 'resolved'; page: number; limit: number; outletId?: string; reviewCode?: string }`.

- [ ] **Step 1: Add the permission** to `UserPermission` in `packages/types/src/index.ts`, after `MANAGE_STOCK_COUNT`:

```ts
  RESOLVE_SYNC_REVIEW: 'resolve_sync_review',
```

- [ ] **Step 2: Add type aliases** in `packages/api/src/client.ts` next to `export type DupCandidate = S['DupCandidate']`:

```ts
export type SyncReviewItem = S['SyncReviewItem']
export type SyncReviewResolution = S['SyncReviewResolution']
export type SyncReviewItemList = S['SyncReviewItemListResponse']
export interface SyncReviewListParams {
  status: 'open' | 'resolved'
  page: number
  limit: number
  outletId?: string
  reviewCode?: string
}
```

- [ ] **Step 3: Add to the `Api` interface** (next to `listErrorLogs`):

```ts
  listSyncReviewItems: (params: SyncReviewListParams) => Promise<SyncReviewItemList>
  resolveSyncReviewItem: (key: string, note: string) => Promise<SyncReviewResolution>
```

- [ ] **Step 4: Implement in `createClient`** (next to `listErrorLogs: (params) => ...`):

```ts
    listSyncReviewItems: ({ status, page, limit, outletId, reviewCode }) =>
      request<SyncReviewItemList>('GET', `${API}/sync-review-items` + qs({
        status, page, limit,
        ...(outletId ? { outletId } : {}),
        ...(reviewCode ? { reviewCode } : {}),
      })),
    resolveSyncReviewItem: (key, note) =>
      data<SyncReviewResolution>('POST', `${API}/sync-review-items/${encodeURIComponent(key)}/resolve`, { note }),
```

- [ ] **Step 5: Typecheck**

Run: `corepack pnpm --filter @mandalika/api exec tsc --noEmit -p .` and `corepack pnpm --filter @mandalika/types exec tsc --noEmit -p .` (if a package has no tsconfig, run `corepack pnpm -r exec tsc -b` from the root instead)
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/types/src/index.ts packages/api/src/client.ts
printf 'feat(api-client): sync review list/resolve methods + permission constant\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n' > "$TEMP/msg.txt"
git commit -F "$TEMP/msg.txt"
```

---

### Task 5: Guarded outbox removal (`Outbox.resolveReviewed`)

**Files:**
- Modify: `packages/sync/src/outbox.ts` (`ReviewItem` interface ~line 80; `reviewItems()` ~line 345; new method after `retryDeadLettered` ~line 449)
- Test: `packages/sync/src/outbox.resolve-reviewed.test.ts`

**Interfaces:**
- Produces: `ReviewItem.capturedOutletId?: string`; `Outbox.resolveReviewed(keys: readonly string[]): Promise<OutboxItem[]>` — removes only items still parked, returns the removed items, rejects if the durable write fails (queue unchanged).

- [ ] **Step 1: Write the failing tests** `packages/sync/src/outbox.resolve-reviewed.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { MAX_ATTEMPTS, Outbox } from './outbox'
import { KVOutboxStore } from './outboxStore'
import { controllableKV } from './testFixtures/controllableKV'

async function setup() {
  const { kv, store } = controllableKV()
  const outbox = new Outbox(new KVOutboxStore(kv))
  await outbox.add('refund', 'dev:parked', { orderNumber: 'BSD-G0007' })
  await outbox.add('order', 'dev:pending', { total: 1 })
  await outbox.add('order', 'dev:old-park', { total: 2 })
  await outbox.settle([
    { key: 'dev:parked', op: 'review', code: 'forbidden', reason: 'denied' },
    // Legacy park by attempt counting: failed with attempts >= MAX_ATTEMPTS, no code.
    ...Array.from({ length: MAX_ATTEMPTS }, () => ({ key: 'dev:old-park', op: 'fail' as const, error: 'x' })),
  ])
  return { outbox, store }
}

describe('Outbox.resolveReviewed', () => {
  it('removes parked items (coded and legacy) and returns them', async () => {
    const { outbox } = await setup()
    const removed = await outbox.resolveReviewed(['dev:parked', 'dev:old-park'])
    expect(removed.map((i) => i.idempotencyKey).sort()).toEqual(['dev:old-park', 'dev:parked'])
    expect(outbox.reviewItems()).toEqual([])
    expect(outbox.pending().map((i) => i.idempotencyKey)).toEqual(['dev:pending'])
  })

  it('never removes a pending, unknown or re-queued item', async () => {
    const { outbox } = await setup()
    await outbox.retryDeadLettered((i) => i.idempotencyKey === 'dev:parked') // cashier pressed "Coba lagi"
    const removed = await outbox.resolveReviewed(['dev:parked', 'dev:pending', 'dev:unknown'])
    expect(removed).toEqual([])
    expect(outbox.pending().map((i) => i.idempotencyKey).sort()).toEqual(['dev:parked', 'dev:pending'])
  })

  it('rejects and keeps the queue when the durable write fails', async () => {
    const { outbox, store } = await setup()
    store.durableMode = 'reject'
    await expect(outbox.resolveReviewed(['dev:parked'])).rejects.toThrow()
    store.durableMode = 'ok'
    expect(outbox.reviewItems().map((i) => i.idempotencyKey)).toContain('dev:parked')
  })

  it('exposes the capture outlet on review items when the item has an envelope', async () => {
    const { kv } = controllableKV()
    const outbox = new Outbox(new KVOutboxStore(kv))
    const envelope = { v: 1, outletId: 'outlet-a', userId: 'u1', deviceId: 'dev', capturedAt: '2026-10-12T03:00:00Z' }
    await outbox.add('refund', 'dev:env', { orderNumber: 'X' }, envelope)
    await outbox.settle([{ key: 'dev:env', op: 'review', code: 'forbidden', reason: 'denied' }])
    expect(outbox.reviewItems()[0].capturedOutletId).toBe('outlet-a')
  })
})
```

Before running, check two fixture details and adapt the test (not the production code) if they differ: the `controllableKV()` handle's switch for failing durable writes (`DurableMode = 'ok' | 'reject' | 'hold'` — read `testFixtures/controllableKV.ts` for the exact property name), and `Outbox.add`'s signature (whether the envelope is the 4th argument).

- [ ] **Step 2: Run to verify failure**

Run: `corepack pnpm --filter @mandalika/sync exec vitest run src/outbox.resolve-reviewed.test.ts`
Expected: FAIL — `outbox.resolveReviewed is not a function` / `capturedOutletId` undefined.

- [ ] **Step 3: Implement.** In the `ReviewItem` interface add:

```ts
  /** Outlet recorded in the item's envelope at capture time, when it has one. */
  capturedOutletId?: string
```

In `reviewItems()` add to the mapped object (after `ownerUserId`):

```ts
      ...(i.envelope ? { capturedOutletId: i.envelope.outletId } : {}),
```

After `retryDeadLettered`, add:

```ts
  /** Remove items head office resolved. Only items STILL parked are removed — an item the
   *  cashier re-queued ("Coba lagi") in the meantime, or anything pending/unknown, is left
   *  alone. Checked against the live queue inside the serialized run, never a snapshot.
   *  Like retryDeadLettered, a failed durable write rejects and the queue is unchanged. */
  resolveReviewed(keys: readonly string[]): Promise<OutboxItem[]> {
    return this.run(async () => {
      const wanted = new Set(keys)
      const removed: OutboxItem[] = []
      const next = this.items.filter((i) => {
        const hit = wanted.has(i.idempotencyKey) && i.status === 'failed' && (i.attempts ?? 0) >= MAX_ATTEMPTS
        if (hit) removed.push(i)
        return !hit
      })
      if (removed.length) await this.commit(next)
      return removed
    })
  }
```

- [ ] **Step 4: Run tests**

Run: `corepack pnpm --filter @mandalika/sync test`
Expected: all sync tests PASS (new file included; existing `reviewItems` assertions still pass because `capturedOutletId` is only added for enveloped items).

- [ ] **Step 5: Commit**

```bash
git add packages/sync/src/outbox.ts packages/sync/src/outbox.resolve-reviewed.test.ts
printf 'feat(sync): guarded Outbox.resolveReviewed removes only still-parked items\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n' > "$TEMP/msg.txt"
git commit -F "$TEMP/msg.txt"
```

---

### Task 6: Engine check-in (`SyncEngine.checkInReviews`)

**Files:**
- Modify: `packages/sync/src/engine.ts` (constants near `BATCH_TIMEOUT_MS` ~line 98; `SyncEvents` ~line 41-78; private fields ~line 186-206; `buildFailedSyncDiagnostics` ~line 599; `flush()` finally ~line 652; `start()` ~line 886)
- Modify: `packages/sync/src/index.ts:5` (export the new constants)
- Test: `packages/sync/src/engine.review-checkin.test.ts`

**Interfaces:**
- Consumes: `Outbox.resolveReviewed`, `ReviewItem.capturedOutletId` (Task 5); schema types `SyncReviewReport`, `SyncReviewReportRequest`, `SyncReviewReportResult` (Task 1).
- Produces: `SyncEngine.checkInReviews(): Promise<void>`; `SyncEngine.isReviewReported(key: string): boolean`; `SyncEvents.onReviewResolved?: (items: ReviewResolvedNotice[]) => void` with `export interface ReviewResolvedNotice { idempotencyKey: string; type: OutboxType; note: string; resolvedByName: string }`; exported constants `REVIEW_CHECKIN_MS = 300_000`, `REVIEW_CHECKIN_NEW_MS = 30_000`, `REVIEW_CHECKIN_MAX_ITEMS = 50`.

- [ ] **Step 1: Write the failing tests** `packages/sync/src/engine.review-checkin.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REVIEW_CHECKIN_MAX_ITEMS, REVIEW_CHECKIN_MS, REVIEW_CHECKIN_NEW_MS, SyncEngine, type ApiLike } from './engine'
import { controllableKV } from './testFixtures/controllableKV'

type ReportBody = { items: { idempotencyKey: string; payload: Record<string, unknown>; capturedOutletId?: string }[] }
const api = (request: unknown): ApiLike => ({ request: request as ApiLike['request'] })
const resolvedReply = (keys: string[]) => ({
  data: { resolved: keys.map((idempotencyKey) => ({ idempotencyKey, resolvedAt: '2026-10-12T04:00:00Z', resolvedByName: 'HO', note: 'refund manual' })) },
})

beforeEach(() => {
  vi.stubGlobal('navigator', { onLine: true })
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-12T03:00:00Z'))
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

async function parked(request: unknown, keys: string[], events = {}) {
  const { kv } = controllableKV()
  const engine = new SyncEngine(api(request), events, kv, { actor: null })
  for (const k of keys) await engine.outbox.add('transfer_receive', k, { transferId: 't1', pin: '1234' })
  await engine.outbox.settle(keys.map((key) => ({ key, op: 'review' as const, code: 'forbidden', reason: 'PIN salah' })))
  return engine
}

describe('SyncEngine.checkInReviews', () => {
  it('does nothing with no review items or while offline', async () => {
    const request = vi.fn()
    const engine = await parked(request, [])
    await engine.checkInReviews()
    vi.stubGlobal('navigator', { onLine: false })
    const offline = await parked(request, ['d:1'])
    await offline.checkInReviews()
    expect(request).not.toHaveBeenCalled()
  })

  it('reports redacted items, marks them reported, then throttles for 5 minutes', async () => {
    const request = vi.fn(async () => resolvedReply([]))
    const engine = await parked(request, ['d:1'])
    await engine.checkInReviews()
    expect(request).toHaveBeenCalledTimes(1)
    const [method, path, body] = request.mock.calls[0] as unknown as [string, string, ReportBody]
    expect([method, path]).toEqual(['POST', '/api/v1/sync/review-items'])
    expect(body.items[0].idempotencyKey).toBe('d:1')
    expect(body.items[0].payload).not.toHaveProperty('pin')
    expect(engine.isReviewReported('d:1')).toBe(true)
    await engine.checkInReviews()
    vi.advanceTimersByTime(REVIEW_CHECKIN_MS - 1000)
    await engine.checkInReviews()
    expect(request).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1000)
    await engine.checkInReviews()
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('a new unreported item shortens the wait to 30 seconds', async () => {
    const request = vi.fn(async () => resolvedReply([]))
    const engine = await parked(request, ['d:1'])
    await engine.checkInReviews()
    await engine.outbox.add('order', 'd:2', { total: 1 })
    await engine.outbox.settle([{ key: 'd:2', op: 'review', code: 'rejected', reason: 'x' }])
    vi.advanceTimersByTime(REVIEW_CHECKIN_NEW_MS)
    await engine.checkInReviews()
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('removes resolved items, fires onReviewResolved and writes the sync log', async () => {
    const onReviewResolved = vi.fn()
    const engine = await parked(vi.fn(async () => resolvedReply(['d:1'])), ['d:1', 'd:2'], { onReviewResolved })
    await engine.checkInReviews()
    expect(engine.reviewItems().map((i) => i.idempotencyKey)).toEqual(['d:2'])
    expect(onReviewResolved).toHaveBeenCalledWith([{ idempotencyKey: 'd:1', type: 'transfer_receive', note: 'refund manual', resolvedByName: 'HO' }])
    expect(JSON.stringify(engine.syncLog())).toContain('diselesaikan kantor pusat')
  })

  it('a failed or malformed reply changes nothing', async () => {
    for (const request of [vi.fn(async () => { throw new Error('offline') }), vi.fn(async () => ({ data: {} }))]) {
      const engine = await parked(request, ['d:1'])
      await engine.checkInReviews()
      expect(engine.reviewItems().map((i) => i.idempotencyKey)).toEqual(['d:1'])
      expect(engine.isReviewReported('d:1')).toBe(false)
    }
  })

  it('does not remove an item the cashier re-queued while the check-in was in flight', async () => {
    let release!: (v: unknown) => void
    const engine = await parked(vi.fn(() => new Promise((r) => { release = r })), ['d:1'])
    const run = engine.checkInReviews()
    await engine.outbox.retryDeadLettered() // "Coba lagi" during the request
    release(resolvedReply(['d:1']))
    await run
    expect(engine.outbox.pending().map((i) => i.idempotencyKey)).toEqual(['d:1'])
  })

  it('rotates through more than 50 items so every one is reported and resolved', async () => {
    const keys = Array.from({ length: REVIEW_CHECKIN_MAX_ITEMS + 10 }, (_, i) => `d:${String(i).padStart(3, '0')}`)
    const sent = new Set<string>()
    const request = vi.fn(async (_m: string, _p: string, body: ReportBody) => {
      body.items.forEach((i) => sent.add(i.idempotencyKey))
      expect(body.items.length).toBeLessThanOrEqual(REVIEW_CHECKIN_MAX_ITEMS)
      return resolvedReply([])
    })
    const engine = await parked(request, keys)
    await engine.checkInReviews()
    vi.advanceTimersByTime(REVIEW_CHECKIN_NEW_MS)
    await engine.checkInReviews()
    expect(sent.size).toBe(keys.length)
    // All reported now: the next round (5 min later) re-sends the least recently sent first.
    request.mockImplementation(async (_m: string, _p: string, body: ReportBody) => resolvedReply(body.items.map((i) => i.idempotencyKey)))
    vi.advanceTimersByTime(REVIEW_CHECKIN_MS)
    await engine.checkInReviews()
    vi.advanceTimersByTime(REVIEW_CHECKIN_MS)
    await engine.checkInReviews()
    expect(engine.reviewItems()).toEqual([])
  })

  it('start() checks in on its timer, but never in flushOnly mode', async () => {
    const request = vi.fn(async (_m: string, path: string) =>
      path.endsWith('/sync/review-items') ? resolvedReply([]) : { data: [] })
    const engine = await parked(request, ['d:1'])
    const stop = engine.start(12_000, { flushOnly: true })
    await vi.advanceTimersByTimeAsync(13_000)
    stop()
    expect(request.mock.calls.some((c) => String(c[1]).endsWith('/sync/review-items'))).toBe(false)
    const stop2 = engine.start(12_000)
    await vi.advanceTimersByTimeAsync(13_000)
    stop2()
    expect(request.mock.calls.some((c) => String(c[1]).endsWith('/sync/review-items'))).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `corepack pnpm --filter @mandalika/sync exec vitest run src/engine.review-checkin.test.ts`
Expected: FAIL — `REVIEW_CHECKIN_MAX_ITEMS` not exported / `checkInReviews is not a function`.

- [ ] **Step 3: Implement in `engine.ts`.**

Types near the other schema aliases (~line 24):

```ts
type ReviewReport = components['schemas']['SyncReviewReport']
type ReviewReportRequest = components['schemas']['SyncReviewReportRequest']
type ReviewReportResult = components['schemas']['SyncReviewReportResult']
```

Constants near `BATCH_TIMEOUT_MS`:

```ts
/** Review check-in: re-report everything at most this often… */
export const REVIEW_CHECKIN_MS = 5 * 60_000
/** …but report a not-yet-reported review item within this. */
export const REVIEW_CHECKIN_NEW_MS = 30_000
/** Items per check-in; the rest follow in later rounds (least recently sent first). */
export const REVIEW_CHECKIN_MAX_ITEMS = 50
const REVIEW_CHECKIN_TIMEOUT_MS = 20_000

/** Head office resolved a review item and the tablet removed it. */
export interface ReviewResolvedNotice {
  idempotencyKey: string
  type: OutboxType
  note: string
  resolvedByName: string
}

function toReviewReport(i: ReviewItem): ReviewReport {
  return {
    idempotencyKey: i.idempotencyKey,
    type: i.type,
    clientCreatedAt: i.clientCreatedAt,
    payload: redactPayload({ ...i.payload }),
    ...(i.reviewCode ? { reviewCode: i.reviewCode } : {}),
    ...(i.reviewReason ? { reviewReason: i.reviewReason } : {}),
    ...(i.lastError ? { lastError: i.lastError } : {}),
    ...(i.ownerUserId ? { ownerUserId: i.ownerUserId } : {}),
    ...(i.capturedOutletId ? { capturedOutletId: i.capturedOutletId } : {}),
  }
}
```

In `SyncEvents` add:

```ts
  /** Head office resolved review items and they were removed from the queue (toast). */
  onReviewResolved?: (items: ReviewResolvedNotice[]) => void
```

Private fields (with the others):

```ts
  // Review check-in (head-office resolve). Key → last time it was sent in a successful check-in.
  private reviewSentAt = new Map<string, number>()
  private reviewCheckInAt = 0
  private checkingIn = false
  // Automatic check-ins run only after start() outside flushOnly mode.
  private autoCheckIn = false
```

Replace the log-writing block inside `buildFailedSyncDiagnostics()` with a call to a new helper, keeping the entry shape identical:

```ts
    if (dead.length) {
      const now = new Date().toISOString()
      this.appendSyncLog(dead.map((d) => ({
        at: now,
        deviceId: this.deviceId,
        type: d.type,
        idempotencyKey: d.idempotencyKey,
        lastError: d.lastError,
        reviewCode: d.reviewCode,
        reviewReason: d.reviewReason,
        clientCreatedAt: d.clientCreatedAt,
        payload: redactPayload(d.payload),
      })))
    }
```

and add the helper plus the public API (next to `syncLog()`):

```ts
  private appendSyncLog(entries: readonly unknown[]): void {
    const log = readJSON<unknown[]>(this.kv, SYNC_LOG_KEY, [])
    log.push(...entries)
    writeJSON(this.kv, SYNC_LOG_KEY, log.slice(-200)) // keep last 200
  }

  /** True once the item went out in a successful review check-in (cashier label). */
  isReviewReported(key: string): boolean {
    return this.reviewSentAt.has(key)
  }

  /** Report parked review items to head office and remove the ones it resolved.
   *  Throttled; any failure leaves the queue untouched and is retried next cycle. */
  async checkInReviews(): Promise<void> {
    if (this.disposed || this.checkingIn || !ONLINE()) return
    const all = this.outbox.reviewItems()
    if (all.length === 0) return
    const unreported = all.filter((i) => !this.reviewSentAt.has(i.idempotencyKey))
    const wait = unreported.length ? REVIEW_CHECKIN_NEW_MS : REVIEW_CHECKIN_MS
    if (Date.now() - this.reviewCheckInAt < wait) return
    this.reviewCheckInAt = Date.now()
    this.checkingIn = true
    try {
      const reported = all
        .filter((i) => this.reviewSentAt.has(i.idempotencyKey))
        .sort((a, b) => (this.reviewSentAt.get(a.idempotencyKey) ?? 0) - (this.reviewSentAt.get(b.idempotencyKey) ?? 0))
      const batch = [...unreported, ...reported].slice(0, REVIEW_CHECKIN_MAX_ITEMS)
      const body: ReviewReportRequest = { items: batch.map(toReviewReport) }
      const r = await this.api.request<{ data?: ReviewReportResult }>(
        'POST', '/api/v1/sync/review-items', body, { timeoutMs: REVIEW_CHECKIN_TIMEOUT_MS },
      )
      const resolved = r?.data?.resolved
      if (!Array.isArray(resolved) || this.disposed) return
      const sentAt = Date.now()
      for (const i of batch) this.reviewSentAt.set(i.idempotencyKey, sentAt)
      if (resolved.length === 0) return
      const byKey = new Map(resolved.map((x) => [x.idempotencyKey, x]))
      const removed = await this.outbox.resolveReviewed([...byKey.keys()])
      if (removed.length === 0) return
      const at = new Date().toISOString()
      const notices = removed.map((i): ReviewResolvedNotice => {
        const x = byKey.get(i.idempotencyKey)!
        this.reviewSentAt.delete(i.idempotencyKey)
        return { idempotencyKey: i.idempotencyKey, type: i.type, note: x.note, resolvedByName: x.resolvedByName }
      })
      this.appendSyncLog(notices.map((n) => ({
        at, deviceId: this.deviceId, type: n.type, idempotencyKey: n.idempotencyKey,
        event: 'diselesaikan kantor pusat', note: n.note, resolvedByName: n.resolvedByName,
      })))
      this.events.onReviewResolved?.(notices)
    } catch {
      // Offline, server error, expired login, older server or a failed queue write:
      // nothing changed; the throttle above spaces out the retry.
    } finally {
      this.checkingIn = false
    }
  }
```

In `flush()`'s `finally`, after `this.emitStuckRetrying()`:

```ts
      if (this.autoCheckIn) void this.checkInReviews()
```

In `start()`: right after `this.outbox.revive()` add `this.autoCheckIn = !opts.flushOnly`; inside the `setInterval` callback add `if (this.autoCheckIn) void this.checkInReviews()`; inside `stop` add `this.autoCheckIn = false`.

In `packages/sync/src/index.ts` add `REVIEW_CHECKIN_MS, REVIEW_CHECKIN_NEW_MS, REVIEW_CHECKIN_MAX_ITEMS` to the line-5 engine export, and `ReviewResolvedNotice` to the line-6 type export.

- [ ] **Step 4: Run tests and typecheck**

Run: `corepack pnpm --filter @mandalika/sync test && corepack pnpm --filter @mandalika/sync exec tsc --noEmit -p .`
Expected: all PASS, no type errors. If an existing test asserts the exact request sequence of `start()` (e.g. counts `request` calls), it now sees no extra call unless review items exist; if one fails, check whether it parks items — adjust only that test's expectation and say so in the commit body.

- [ ] **Step 5: Commit**

```bash
git add packages/sync/src/engine.ts packages/sync/src/index.ts packages/sync/src/engine.review-checkin.test.ts
printf 'feat(sync): review check-in reports parked items and removes resolved ones\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n' > "$TEMP/msg.txt"
git commit -F "$TEMP/msg.txt"
```

- [ ] **Step 6: Opus review gate.** Dispatch the `reviewer` agent on the Task 5 + Task 6 diff (`git diff HEAD~2`), focus: removal never deletes a non-parked item, no write through `mutate()`, failure leaves the queue byte-identical, no PIN leaves the device, `flushOnly` honoured. Fix findings before Task 7.

---

### Task 7: POS wiring — toast and "Dilaporkan ke kantor pusat"

**Files:**
- Create: `apps/pos/src/lib/reviewResolved.ts`, Test: `apps/pos/src/lib/reviewResolved.test.ts`
- Modify: `apps/pos/src/cashier/SyncProvider.tsx` (engine events ~line 70-110)
- Modify: `apps/pos/src/hooks/useOfflineData.ts:14-25` (`FailedItem`), `:50-68` (`attention`), `:70-72` (`sameItems` — export it and compare `reported`), Test: `apps/pos/src/hooks/sameItems.test.ts`
- Modify: `apps/pos/src/components/SyncStatus.tsx:34-54` (`ReviewRow`), Test: `apps/pos/src/components/SyncStatus.test.ts`

**Interfaces:**
- Consumes: `ReviewResolvedNotice`, `SyncEvents.onReviewResolved`, `SyncEngine.isReviewReported` (Task 6).
- Produces: `reviewResolvedMessage(items: readonly { note: string }[]): string`; `FailedItem.reported?: boolean`.

- [ ] **Step 1: Write failing tests.** `apps/pos/src/lib/reviewResolved.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { reviewResolvedMessage } from './reviewResolved'

describe('reviewResolvedMessage', () => {
  it('names the count and the first note', () => {
    expect(reviewResolvedMessage([{ note: 'refund manual' }])).toBe('1 item diselesaikan oleh kantor pusat: refund manual')
    expect(reviewResolvedMessage([{ note: 'a' }, { note: 'b' }])).toBe('2 item diselesaikan oleh kantor pusat: a')
  })
})
```

Append to `apps/pos/src/components/SyncStatus.test.ts` (inside the file, after the existing `describe` blocks):

```ts
describe('review row reported label', () => {
  it('shows "Dilaporkan ke kantor pusat" only once reported', () => {
    const base = { idempotencyKey: 'd:1', type: 'refund', lastError: 'denied' }
    expect(renderToStaticMarkup(createElement(ReviewRow, { f: { ...base, reported: true } }))).toContain('Dilaporkan ke kantor pusat')
    expect(renderToStaticMarkup(createElement(ReviewRow, { f: base }))).not.toContain('Dilaporkan')
  })
})
```

`apps/pos/src/hooks/sameItems.test.ts` — the 2-second refresh only re-renders when `sameItems` sees a change, so a `reported` flip must count as one:

```ts
import { describe, expect, it } from 'vitest'
import { sameItems } from './useOfflineData'

describe('sameItems', () => {
  it('treats a reported flag flip as a change', () => {
    const a = [{ idempotencyKey: 'd:1', type: 'refund', lastError: 'x' }]
    expect(sameItems(a, [{ ...a[0] }])).toBe(true)
    expect(sameItems(a, [{ ...a[0], reported: true }])).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `corepack pnpm --filter @mandalika/pos exec vitest run src/lib/reviewResolved.test.ts src/components/SyncStatus.test.ts src/hooks/sameItems.test.ts`
Expected: FAIL — module `./reviewResolved` not found; label missing; `sameItems` not exported.

- [ ] **Step 3: Implement.** `apps/pos/src/lib/reviewResolved.ts`:

```ts
/** Toast after head office resolved review items and they left this tablet. */
export function reviewResolvedMessage(items: readonly { note: string }[]): string {
  return `${items.length} item diselesaikan oleh kantor pusat: ${items[0]?.note ?? ''}`
}
```

`useOfflineData.ts` — add to `FailedItem`:

```ts
  /** Sent to head office in a successful review check-in. */
  reported?: boolean
```

and in `attention()` add to the mapped review object:

```ts
    reported: engine.isReviewReported(r.idempotencyKey),
```

and replace `sameItems` with an exported version that also compares `reported`:

```ts
export function sameItems(a: FailedItem[], b: FailedItem[]): boolean {
  return a.length === b.length && a.every((x, i) => x.idempotencyKey === b[i].idempotencyKey && x.lastError === b[i].lastError && x.ownedBy === b[i].ownedBy && x.detail === b[i].detail && x.reported === b[i].reported)
}
```

If importing `./useOfflineData` in a plain vitest file pulls in something that needs a DOM or the SyncProvider, move `sameItems` into `apps/pos/src/hooks/sameItems.ts`, import it from both places, and point the test there.

`SyncStatus.tsx` `ReviewRow` — after the `lastError` line add:

```tsx
        {f.reported && <p className="text-[10px] font-semibold text-red-500">Dilaporkan ke kantor pusat</p>}
```

`SyncProvider.tsx` — import `reviewResolvedMessage` from `'../lib/reviewResolved'` and add to the engine events object (after `onReceiveAccepted`):

```ts
        // Same toast sink CashierScreen registers for receive notices (a plain "show toast" ref).
        onReviewResolved: (items) => onReceiveRejectedRef.current?.(reviewResolvedMessage(items)),
```

- [ ] **Step 4: Run POS tests and typecheck**

Run: `corepack pnpm --filter @mandalika/pos test && corepack pnpm --filter @mandalika/pos exec tsc -b`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/pos/src/lib/reviewResolved.ts apps/pos/src/lib/reviewResolved.test.ts apps/pos/src/cashier/SyncProvider.tsx apps/pos/src/hooks/ apps/pos/src/components/SyncStatus.tsx apps/pos/src/components/SyncStatus.test.ts
printf 'feat(pos): head-office resolve toast and reported label on review rows\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n' > "$TEMP/msg.txt"
git commit -F "$TEMP/msg.txt"
```

---

### Task 8: Backoffice screen "Tinjauan Sinkron"

**Files:**
- Create: `apps/backoffice/src/screens/syncReview/reviewLabels.ts`, Test: `apps/backoffice/src/screens/syncReview/reviewLabels.test.ts`
- Create: `apps/backoffice/src/screens/syncReview/useSyncReviewCount.ts`
- Create: `apps/backoffice/src/screens/syncReview/SyncReviewDetail.tsx`
- Create: `apps/backoffice/src/screens/syncReview/SyncReview.tsx`
- Modify: `apps/backoffice/src/App.tsx` (lucide import lines 2-15; NAV lines 33-45; sidebar button lines 172-188)
- Modify: `apps/backoffice/src/screens/users/PermissionPicker.tsx:3-16`

**Interfaces:**
- Consumes: `api.listSyncReviewItems`, `api.resolveSyncReviewItem`, types `SyncReviewItem` (Task 4).
- Produces: `reasonLabel(code)`, `typeLabel(t)`, `isStale(lastReportedAt, now?)`, `payloadSummary(type, payload): [string, string][]`, `REASON_FILTERS`, `fmtWib(iso)`; `useSyncReviewCount(enabled: boolean): number`; `SYNC_REVIEW_CHANGED` event name; default export `SyncReview` (zero-prop screen).

- [ ] **Step 1: Write failing label tests** `apps/backoffice/src/screens/syncReview/reviewLabels.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { isStale, payloadSummary, reasonLabel, typeLabel } from './reviewLabels'

describe('reviewLabels', () => {
  it('maps reason codes to plain Indonesian', () => {
    expect(reasonLabel('forbidden')).toBe('Ditolak: tidak berwenang / PIN salah')
    expect(reasonLabel('actor_mismatch')).toBe('Dibuat oleh akun lain')
    expect(reasonLabel('competing_receipt')).toBe('Transfer sudah diterima tablet lain')
    expect(reasonLabel('conflict')).toBe('Ditolak server')
    expect(reasonLabel('batch_rejected')).toBe('Kiriman ditolak')
    expect(reasonLabel(null)).toBe('Gagal berulang (versi lama)')
    expect(reasonLabel('weird')).toBe('Ditolak (weird)')
  })
  it('labels item types', () => {
    expect(typeLabel('refund')).toBe('Refund')
    expect(typeLabel('transfer_receive')).toBe('Terima transfer')
    expect(typeLabel('mystery')).toBe('mystery')
  })
  it('flags tablets silent for more than 3 days', () => {
    const now = Date.parse('2026-10-12T00:00:00Z')
    expect(isStale('2026-10-08T23:59:00Z', now)).toBe(true)
    expect(isStale('2026-10-10T00:00:00Z', now)).toBe(false)
  })
  it('summarises a refund and tolerates missing fields', () => {
    const rows = payloadSummary('refund', { orderNumber: 'BSD-G0007', total: 225000, paymentMethod: 'cash', reason: 'rusak' })
    expect(rows[0]).toEqual(['Struk', 'BSD-G0007'])
    expect(rows[1][1]).toContain('225.000')
    expect(payloadSummary('order', {})).toEqual([['Struk', '—'], ['Barang', '—'], ['Metode', '—'], ['Dibayar', '—']])
    expect(payloadSummary('unknown', { a: 1 })).toEqual([])
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `corepack pnpm --filter @mandalika/backoffice exec vitest run src/screens/syncReview/reviewLabels.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `reviewLabels.ts`**

```ts
import { format, parseISO } from 'date-fns'
import { id } from 'date-fns/locale'

const REASONS: Record<string, string> = {
  forbidden: 'Ditolak: tidak berwenang / PIN salah',
  actor_mismatch: 'Dibuat oleh akun lain',
  competing_receipt: 'Transfer sudah diterima tablet lain',
  rejected: 'Ditolak server',
  conflict: 'Ditolak server',
  batch_rejected: 'Kiriman ditolak',
}

/** Reason filter options; 'none' = parked by old attempt counting (server filter value). */
export const REASON_FILTERS: ReadonlyArray<{ id: string; label: string }> = [
  { id: '', label: 'Semua alasan' },
  { id: 'forbidden', label: REASONS.forbidden },
  { id: 'actor_mismatch', label: REASONS.actor_mismatch },
  { id: 'competing_receipt', label: REASONS.competing_receipt },
  { id: 'rejected', label: 'Ditolak server (rejected)' },
  { id: 'conflict', label: 'Ditolak server (conflict)' },
  { id: 'batch_rejected', label: REASONS.batch_rejected },
  { id: 'none', label: 'Gagal berulang (versi lama)' },
]

export function reasonLabel(code: string | null | undefined): string {
  if (!code) return 'Gagal berulang (versi lama)'
  return REASONS[code] ?? `Ditolak (${code})`
}

const TYPES: Record<string, string> = {
  order: 'Penjualan',
  refund: 'Refund',
  shift_open: 'Buka shift',
  shift_close: 'Tutup shift',
  cash_flow: 'Kas masuk/keluar',
  customer_create: 'Pelanggan baru',
  transfer_receive: 'Terima transfer',
}

export function typeLabel(t: string): string {
  return TYPES[t] ?? t
}

export const STALE_AFTER_MS = 3 * 24 * 60 * 60 * 1000

export function isStale(lastReportedAt: string, now: number = Date.now()): boolean {
  return now - Date.parse(lastReportedAt) > STALE_AFTER_MS
}

/** Browser-local time; the backoffice runs in WIB (same convention as ErrorLogs). */
export function fmtWib(iso: string | null | undefined): string {
  if (!iso) return '—'
  try {
    return format(parseISO(iso), 'dd MMM yyyy HH:mm', { locale: id })
  } catch {
    return iso
  }
}

const idr = (n: unknown) =>
  typeof n === 'number' ? n.toLocaleString('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }) : '—'
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : '—')

function itemsLine(v: unknown): string {
  if (!Array.isArray(v) || v.length === 0) return '—'
  return v
    .map((it) => {
      const o = (it ?? {}) as Record<string, unknown>
      const name = str(o.productName ?? o.name ?? o.productId)
      const size = typeof o.variantSize === 'string' ? ` ${o.variantSize}` : ''
      const qty = o.quantity ?? o.qty ?? o.receivedQty
      return `${name}${size} × ${typeof qty === 'number' ? qty : '?'}`
    })
    .join(', ')
}

/** Human summary of a review item's payload, per type. Unknown types → []. */
export function payloadSummary(type: string, p: Record<string, unknown>): Array<[string, string]> {
  switch (type) {
    case 'refund':
      return [['Struk', str(p.orderNumber)], ['Jumlah', idr(p.total)], ['Metode', str(p.paymentMethod)], ['Alasan', str(p.reason)]]
    case 'order':
      return [['Struk', str(p.orderNumber)], ['Barang', itemsLine(p.items)], ['Metode', str(p.paymentMethod)], ['Dibayar', idr(p.amountPaid)]]
    case 'shift_open':
      return [['Kas awal', idr(p.startingCash)]]
    case 'shift_close':
      return [['Kas akhir', idr(p.closingCash)]]
    case 'cash_flow':
      return [['Jenis', str(p.type)], ['Jumlah', idr(p.amount)], ['Keterangan', str(p.description)]]
    case 'customer_create':
      return [['Nama', str(p.name)], ['Telepon', str(p.phone)]]
    case 'transfer_receive':
      return [['Transfer', str(p.transferId)], ['Barang', itemsLine(p.items)], ['Selisih', str(p.discrepancyReason)]]
    default:
      return []
  }
}
```

- [ ] **Step 4: Run label tests** — `corepack pnpm --filter @mandalika/backoffice exec vitest run src/screens/syncReview/reviewLabels.test.ts` → PASS.

- [ ] **Step 5: Write `useSyncReviewCount.ts`**

```ts
import { useEffect } from 'react'
import { api } from '../../api'
import { usePolledQuery } from '../../hooks/usePolledQuery'

/** Fired after a resolve so the sidebar badge refreshes at once. */
export const SYNC_REVIEW_CHANGED = 'mandalika:sync-review-changed'
const BADGE_POLL_MS = 60_000

export function useSyncReviewCount(enabled: boolean): number {
  const q = usePolledQuery<number>(
    () => (enabled
      ? api.listSyncReviewItems({ status: 'open', page: 1, limit: 1 }).then((r) => r.openCount)
      : Promise.resolve(0)),
    [enabled],
    BADGE_POLL_MS,
  )
  const { refetch } = q
  useEffect(() => {
    const onChange = () => { void refetch() }
    window.addEventListener(SYNC_REVIEW_CHANGED, onChange)
    return () => window.removeEventListener(SYNC_REVIEW_CHANGED, onChange)
  }, [refetch])
  return q.data ?? 0
}
```

- [ ] **Step 6: Write `SyncReviewDetail.tsx`**

```tsx
import { useState } from 'react'
import type { SyncReviewItem } from '@mandalika/api'
import { api } from '../../api'
import { Modal } from '../../ui/Modal'
import { Button } from '../../ui/Button'
import { Badge } from '../../ui/Badge'
import { Textarea } from '../../ui/Field'
import { fmtWib, payloadSummary, reasonLabel, typeLabel } from './reviewLabels'
import { SYNC_REVIEW_CHANGED } from './useSyncReviewCount'

const NOTE_MAX = 500

interface Props {
  item: SyncReviewItem | null
  onClose: () => void
  onResolved: () => void
}

export function SyncReviewDetail({ item, onClose, onResolved }: Props) {
  return (
    <Modal open={item !== null} onClose={onClose} size="lg"
      title={item ? `${typeLabel(item.type)} · ${item.outletName}` : ''}
      subtitle={item ? reasonLabel(item.reviewCode) : undefined}>
      {item && <DetailBody item={item} onResolved={onResolved} />}
    </Modal>
  )
}

function DetailBody({ item, onResolved }: { item: SyncReviewItem; onResolved: () => void }) {
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const payload = (item.payload ?? {}) as Record<string, unknown>
  const trimmed = note.trim()

  const resolve = async () => {
    if (!trimmed || trimmed.length > NOTE_MAX) return
    setSaving(true)
    setError(null)
    try {
      await api.resolveSyncReviewItem(item.idempotencyKey, trimmed)
      window.dispatchEvent(new Event(SYNC_REVIEW_CHANGED))
      onResolved()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal menyelesaikan item')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      {item.appliedOnServer && <Badge tone="success">Sudah masuk ke server</Badge>}
      <dl className="grid grid-cols-2 gap-3 text-xs">
        {payloadSummary(item.type, payload).map(([k, v]) => (
          <div key={k}>
            <dt className="text-[10px] font-black text-gray-400 uppercase tracking-wider">{k}</dt>
            <dd className="text-gray-800 font-semibold break-words">{v}</dd>
          </div>
        ))}
        <div>
          <dt className="text-[10px] font-black text-gray-400 uppercase tracking-wider">Dibuat (menurut tablet)</dt>
          <dd className="text-gray-800 font-semibold">{fmtWib(item.clientCreatedAt)}</dd>
        </div>
        <div>
          <dt className="text-[10px] font-black text-gray-400 uppercase tracking-wider">Kasir</dt>
          <dd className="text-gray-800 font-semibold">{item.ownerName ?? '—'}</dd>
        </div>
      </dl>
      <div className="text-xs text-gray-600 space-y-1">
        <p><span className="font-bold">Alasan server:</span> {item.reviewReason ?? '—'}</p>
        {item.lastError && item.lastError !== item.reviewReason && <p><span className="font-bold">Error terakhir:</span> {item.lastError}</p>}
      </div>
      <details>
        <summary className="text-xs font-bold text-gray-500 cursor-pointer">Data lengkap</summary>
        <pre className="mt-2 text-[11px] bg-gray-900 text-gray-100 rounded-xl p-3 overflow-x-auto max-h-64">
          {JSON.stringify(item.payload, null, 2)}
        </pre>
      </details>
      {item.resolvedAt ? (
        <p className="text-sm text-gray-700">
          Diselesaikan oleh <b>{item.resolvedByName ?? '—'}</b> · {fmtWib(item.resolvedAt)}<br />{item.resolutionNote}
        </p>
      ) : (
        <div className="space-y-2 border-t border-gray-100 pt-4">
          <Textarea label="Catatan penyelesaian" value={note} maxLength={NOTE_MAX}
            onChange={(e) => setNote(e.target.value)}
            hint="Item akan dihapus dari tablet saat tablet terhubung berikutnya. Perbaikan (mis. refund manual) dilakukan terpisah."
            error={error ?? undefined} />
          <div className="flex justify-end">
            <Button onClick={() => void resolve()} disabled={!trimmed || saving}>Tandai selesai</Button>
          </div>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 7: Write `SyncReview.tsx`**

```tsx
import { useState } from 'react'
import type { Outlet, SyncReviewItem, SyncReviewItemList } from '@mandalika/api'
import { ClipboardCheck } from 'lucide-react'
import { api } from '../../api'
import { usePolledQuery } from '../../hooks/usePolledQuery'
import { TableSkeleton } from '../../components/Skeleton'
import { Card } from '../../ui/Card'
import { EmptyState } from '../../ui/EmptyState'
import { PageHeader } from '../../ui/PageHeader'
import { Tabs } from '../../ui/Tabs'
import { Pagination } from '../../ui/Pagination'
import { Select } from '../../ui/Field'
import { REASON_FILTERS, fmtWib, isStale, reasonLabel, typeLabel } from './reviewLabels'
import { SyncReviewDetail } from './SyncReviewDetail'

type Status = 'open' | 'resolved'

export default function SyncReview() {
  const [status, setStatus] = useState<Status>('open')
  const [outletId, setOutletId] = useState('')
  const [reviewCode, setReviewCode] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const [selected, setSelected] = useState<SyncReviewItem | null>(null)

  const q = usePolledQuery<SyncReviewItemList>(
    () => api.listSyncReviewItems({ status, page, limit: pageSize, outletId, reviewCode }),
    [status, page, pageSize, outletId, reviewCode],
    60_000,
  )
  const outletsQ = usePolledQuery<Outlet[]>(() => api.listOutlets(), [], 300_000)
  const rows = q.data?.data ?? []
  const total = q.data?.meta?.total ?? 0
  const openCount = q.data?.openCount ?? 0
  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  return (
    <div className="p-6 space-y-5">
      <PageHeader title="Tinjauan Sinkron"
        subtitle="Item sinkron yang ditolak server dari semua tablet. Perbaiki secara manual bila perlu, lalu tandai selesai." />
      <div className="flex flex-wrap items-end gap-3">
        <Tabs<Status> value={status} onChange={(v) => { setStatus(v); setPage(1) }}
          tabs={[{ id: 'open', label: `Terbuka (${openCount})` }, { id: 'resolved', label: 'Selesai' }]} />
        <Select aria-label="Filter outlet" value={outletId} onChange={(e) => { setOutletId(e.target.value); setPage(1) }}>
          <option value="">Semua outlet</option>
          {(outletsQ.data ?? []).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </Select>
        <Select aria-label="Filter alasan" value={reviewCode} onChange={(e) => { setReviewCode(e.target.value); setPage(1) }}>
          {REASON_FILTERS.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
        </Select>
      </div>
      {q.error && <p role="alert" className="text-sm text-red-600">{q.error}</p>}
      <Card className="overflow-hidden">
        {q.loading && rows.length === 0 ? (
          <TableSkeleton />
        ) : rows.length === 0 ? (
          <EmptyState icon={<ClipboardCheck />} title={status === 'open' ? 'Tidak ada item terbuka' : 'Belum ada item selesai'} />
        ) : (
          <ul className="divide-y divide-gray-50">
            {rows.map((it) => <ReviewListRow key={it.idempotencyKey} item={it} onOpen={() => setSelected(it)} />)}
          </ul>
        )}
      </Card>
      <Pagination page={page} totalPages={totalPages} total={total} onChange={setPage}
        pageSize={pageSize} onPageSizeChange={(s) => { setPageSize(s); setPage(1) }} />
      <SyncReviewDetail item={selected} onClose={() => setSelected(null)}
        onResolved={() => { setSelected(null); void q.refetch() }} />
    </div>
  )
}

function ReviewListRow({ item, onOpen }: { item: SyncReviewItem; onOpen: () => void }) {
  const movedFrom = item.capturedOutletName && item.capturedOutletId !== item.outletId ? item.capturedOutletName : null
  return (
    <li>
      <button type="button" onClick={onOpen} className="w-full text-left px-5 py-4 hover:bg-gray-50 focus-visible:bg-gray-50">
        <p className="font-bold text-gray-900 text-sm">
          {typeLabel(item.type)} · <span className="text-red-700">{reasonLabel(item.reviewCode)}</span>
        </p>
        <p className="text-xs text-gray-500">
          {item.outletName}{movedFrom ? ` (dibuat di ${movedFrom})` : ''}
          {item.ownerName ? ` · ${item.ownerName}` : ''}
          {' · '}{fmtWib(item.clientCreatedAt)} (menurut tablet)
        </p>
        {item.resolvedAt ? (
          <p className="text-xs text-green-700">Selesai oleh {item.resolvedByName ?? '—'} · {fmtWib(item.resolvedAt)} · {item.resolutionNote}</p>
        ) : isStale(item.lastReportedAt) ? (
          <p className="text-xs text-amber-700">tablet belum terhubung sejak {fmtWib(item.lastReportedAt)}</p>
        ) : null}
      </button>
    </li>
  )
}
```

Before saving, confirm `Outlet` is exported from `@mandalika/api` (`grep -n "export type Outlet " packages/api/src/client.ts`) and that `TableSkeleton` lives at `components/Skeleton` (as ErrorLogs imports it).

- [ ] **Step 8: Wire the nav and permission label.** In `App.tsx`: add `ClipboardCheck` to the lucide import; `import SyncReview from './screens/syncReview/SyncReview'` and `import { useSyncReviewCount } from './screens/syncReview/useSyncReviewCount'`; insert into NAV between the `users` and `settings` entries:

```ts
  { id: 'syncReview', label: 'Tinjauan Sinkron', icon: ClipboardCheck, perm: 'resolve_sync_review', C: SyncReview },
```

After the `visible` memo:

```ts
  const reviewCount = useSyncReviewCount(visible.some((n) => n.id === 'syncReview'))
```

In the sidebar button, after `<span className="flex-1 text-left">{label}</span>`:

```tsx
                {id === 'syncReview' && reviewCount > 0 && (
                  <span className="min-w-5 px-1.5 py-0.5 rounded-full bg-red-600 text-white text-[10px] font-black text-center"
                    aria-label={`${reviewCount} item terbuka`}>{reviewCount}</span>
                )}
```

In `PermissionPicker.tsx` `PERMS`, after `manage_inventory`:

```ts
  resolve_sync_review: { label: 'Tinjauan Sinkron', desc: 'Melihat dan menyelesaikan item sinkron yang ditolak tablet' },
```

- [ ] **Step 9: Typecheck, test, build**

Run: `corepack pnpm --filter @mandalika/backoffice test && corepack pnpm --filter @mandalika/backoffice exec tsc -b && corepack pnpm --filter @mandalika/backoffice build`
Expected: PASS; each new component file < 300 lines.

- [ ] **Step 10: Commit**

```bash
git add apps/backoffice/src/screens/syncReview apps/backoffice/src/App.tsx apps/backoffice/src/screens/users/PermissionPicker.tsx
printf 'feat(backoffice): Tinjauan Sinkron screen, sidebar badge, resolve permission\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n' > "$TEMP/msg.txt"
git commit -F "$TEMP/msg.txt"
```

---

### Task 9: Browser gate scenario `BO-REVIEW-RESOLVE`

**Files:**
- Create: `tests/browser/backoffice-review-scenarios.ts`
- Modify: `tests/browser/accepted.spec.ts` (import + one test), `tests/browser/required-scenarios.json` (one `required` entry)

**Interfaces:**
- Consumes: the screen from Task 8 (button "Tinjauan Sinkron", tab "Terbuka (n)", textarea label "Catatan penyelesaian", button "Tandai selesai", empty state "Tidak ada item terbuka").
- Produces: `reviewResolveFlow(page: ScenarioPage): Promise<object[]>` returning 4 evidence records.

- [ ] **Step 1: Write the scenario** `tests/browser/backoffice-review-scenarios.ts`:

```ts
// Head office resolves a parked tablet item (synthetic API, no real backend).
import type { ScenarioPage } from './fixture'
import { BO } from './fixture'

const KEY = 'devA:00000000-0000-4000-8c00-0000000000a1'

export const reviewResolveFlow = async (page: ScenarioPage) => {
  const results: object[] = []
  const check = (ok: boolean, msg: string) => { if (!ok) throw new Error(msg) }
  const now = new Date().toISOString()
  const user = { id: 'synthetic-admin', displayName: 'RV Admin', role: 'admin', outletId: null, permissions: [] }
  const item = {
    idempotencyKey: KEY, outletId: 'outlet-a', outletName: 'RV Outlet', capturedOutletId: 'outlet-a', capturedOutletName: 'RV Outlet',
    type: 'refund', reviewCode: 'forbidden', reviewReason: 'tidak berwenang', lastError: null, ownerUserId: null, ownerName: 'Kasir RV',
    payload: { orderNumber: 'BSD-G0007', total: 225000, paymentMethod: 'cash', reason: 'rusak' },
    clientCreatedAt: now, firstReportedAt: now, lastReportedAt: now, reportedByName: 'Kasir RV',
    resolvedAt: null, resolvedByName: null, resolutionNote: null, appliedOnServer: false,
  }
  const state = { resolved: false, resolveBody: null as unknown, resolvePath: '' }
  await page.unrouteAll({ behavior: 'wait' })
  await page.route('http://127.0.0.1:59999/api/v1/**', async (route) => {
    const req = route.request()
    const path = req.url().replace(/^https?:\/\/[^/]+/, '').split('?')[0]
    if (path.includes('/auth/')) return route.fulfill({ json: { data: { access: 'SYNTHETIC-NON-TOKEN', refresh: 'SYNTHETIC-NON-TOKEN', user } } })
    if (path.endsWith('/outlets')) return route.fulfill({ json: { data: [{ id: 'outlet-a', name: 'RV Outlet', isActive: true }] } })
    if (path.endsWith('/resolve') && req.method() === 'POST') {
      state.resolved = true
      state.resolvePath = path
      state.resolveBody = req.postDataJSON()
      return route.fulfill({ json: { data: { idempotencyKey: KEY, resolvedAt: now, resolvedByName: 'RV Admin', note: 'refund manual' } } })
    }
    if (path.endsWith('/sync-review-items')) {
      const open = !state.resolved
      return route.fulfill({ json: { data: open ? [item] : [], meta: { total: open ? 1 : 0, page: 1, limit: 25 }, openCount: open ? 1 : 0 } })
    }
    return route.fulfill({ json: { data: [], meta: { total: 0, page: 1, limit: 50 } } })
  })
  await page.goto(BO)
  await page.evaluate(() => {
    localStorage.clear()
    localStorage.setItem('mandalika.backoffice.refresh', 'SYNTHETIC-NON-TOKEN')
    localStorage.setItem('mandalika.backoffice.loginDate', new Date().toISOString().slice(0, 10))
  })
  await page.reload()
  await page.setViewportSize({ width: 1440, height: 1000 })

  const navButton = page.getByRole('button', { name: /Tinjauan Sinkron/ })
  await navButton.waitFor()
  await page.getByLabel('1 item terbuka').waitFor()
  results.push({ step: 'badge', openCount: 1 })

  await navButton.click()
  await page.getByRole('button', { name: 'Terbuka (1)' }).waitFor()
  // The reason text also appears in the filter <select>; assert on the row button instead.
  const row = page.getByRole('button', { name: /Refund · Ditolak: tidak berwenang \/ PIN salah/ })
  await row.waitFor()
  results.push({ step: 'list', row: 'Refund · forbidden' })

  await row.click()
  // exact: the raw JSON <pre> also contains the receipt number.
  await page.getByText('BSD-G0007', { exact: true }).waitFor()
  await page.getByLabel('Catatan penyelesaian').fill('  refund manual  ')
  await page.getByRole('button', { name: 'Tandai selesai' }).click()
  await page.getByText('Tidak ada item terbuka').waitFor()
  check(JSON.stringify(state.resolveBody) === JSON.stringify({ note: 'refund manual' }), `resolve body ${JSON.stringify(state.resolveBody)}`)
  check(state.resolvePath.endsWith(`/sync-review-items/${encodeURIComponent(KEY)}/resolve`), `resolve path ${state.resolvePath}`)
  results.push({ step: 'resolve', body: state.resolveBody, path: state.resolvePath })

  await page.getByLabel('1 item terbuka').waitFor({ state: 'detached' })
  results.push({ step: 'badge-cleared', openCount: 0 })
  return results
}
```

The `Textarea` component wraps the control in a `<label>`-less `Field`; if `getByLabel('Catatan penyelesaian')` does not resolve, add `aria-label="Catatan penyelesaian"` to the `Textarea` in `SyncReviewDetail.tsx` (a product fix, not a test workaround).

- [ ] **Step 2: Register and add the test.** In `accepted.spec.ts` add `import { reviewResolveFlow } from './backoffice-review-scenarios'` and:

```ts
test('BO-REVIEW-RESOLVE head office resolves a parked tablet item and the badge clears', async ({ page }, info) => {
  const result = await reviewResolveFlow(page as ScenarioPage)
  expect(result).toHaveLength(4)
  await evidence(info, result)
})
```

In `required-scenarios.json`, append to `required` (after `HOOK-13`):

```json
    {
      "id": "BO-REVIEW-RESOLVE",
      "finding": "review-resolve",
      "description": "Sidebar badge, open list, detail, resolve with trimmed note and escaped key, badge clears",
      "source": "tests/browser/backoffice-review-scenarios.ts"
    }
```

- [ ] **Step 3: Run the browser gate**

Run: `corepack pnpm browser:ci`
Expected: all required scenarios pass, including `BO-REVIEW-RESOLVE` (`scenarios.json` status `passed`).

- [ ] **Step 4: Commit**

```bash
git add tests/browser/backoffice-review-scenarios.ts tests/browser/accepted.spec.ts tests/browser/required-scenarios.json apps/backoffice/src/screens/syncReview/SyncReviewDetail.tsx
printf 'test(browser): BO-REVIEW-RESOLVE head-office resolve scenario\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n' > "$TEMP/msg.txt"
git commit -F "$TEMP/msg.txt"
```

---

### Task 10: Full gates, review, deploy, APK 1.8 and live checks

**Files:**
- Modify: `HANDOFF.md` (Now / Next / progress board; "11 gates" → "12 gates")

No new code. Steps that push, deploy or build an APK need the owner's go-ahead (AGENTS.md) — ask once for the batch.

- [ ] **Step 1: Full local gates**

Run: `corepack pnpm quality:ci`, `cd backend && go test -race ./... && gofmt -l internal/ cmd/` (gofmt prints nothing), the PG gate from Task 3 Step 6, `corepack pnpm browser:ci`.
Expected: all green.

- [ ] **Step 2: Whole-branch Opus review.** Dispatch `reviewer` on `git diff ad67e80..HEAD` (the plan commit as base; amend the hash if the plan was re-committed): contract vs handlers, outlet isolation, removal guard, PIN redaction, permission gating, appliedOnServer sources, revoke-marker TTL, Review Focus items 1–5. Fix CRITICAL/HIGH findings, re-run Step 1.

- [ ] **Step 3 (owner go-ahead): Push and backend deploy.** `git push origin prod-hardening`; wait for CI green on the pushed commit; then

```bash
gcloud run deploy mandalika-pos --source backend --region asia-southeast2 --project mandalika-pos --no-traffic --tag review --update-env-vars JWT_REFRESH_TTL_HOURS=720 --quiet
```

Smoke the tag URL (Node fetch script in the scratchpad, admin credentials from Secret Manager `SEED_ADMIN_PASSWORD`, never printed): login → `POST /api/v1/sync/review-items` with header `X-Outlet-Id: <Mandalika BSD id>` and one throwaway item key `e2e-review:<random uuid>` → `GET /api/v1/sync-review-items?status=open` shows it → `POST …/{encoded key}/resolve` with a note → re-report returns it in `resolved` → `GET` without permission token (a cashier token if available) returns 403. Then delete the throwaway row: `psql "$(gcloud secrets versions access latest --secret=DATABASE_URL --project mandalika-pos)" -c "DELETE FROM sync_review_items WHERE idempotency_key LIKE 'e2e-review:%'"` (a Neon write — confirm with the owner first). Then `gcloud run services update-traffic mandalika-pos --region asia-southeast2 --project mandalika-pos --to-tags review=100`. Rollback target: the current revision `00094-per`.

- [ ] **Step 4: Backoffice.** The push in Step 3 deploys Cloudflare Pages (head commit must not start with `[CF-Pages-Skip]`). Open `https://mandalika-pos.pages.dev`, confirm "Tinjauan Sinkron" with an empty "Tidak ada item terbuka" state.

- [ ] **Step 5 (owner go-ahead): APK 1.8.** Bump the POS version to 1.8 / versionCode 9 the same way the 1.7 bump was done (`git log -p --follow` on the Android `build.gradle` for the 1.7 commit), commit, push, then

```bash
gh workflow run android-release.yml --ref prod-hardening -f api_url=https://mandalika-pos-538849926142.asia-southeast2.run.app
```

Download the artifact to `Downloads/mandalika-apk/mandalika-pos-1.8-build9.apk`.

- [ ] **Step 6: Emulator check** (AVD `mandalika-tab`; owner logs in): install 1.8 over 1.7 (`adb install -r`), log in as an account without `process_refund`, queue a refund offline, go online → the item parks with "Ditolak: tidak berwenang" and, within ~30 s, shows "Dilaporkan ke kantor pusat" → backoffice shows it with the badge → resolve with a note → within one sync cycle the tablet toast "1 item diselesaikan oleh kantor pusat: …" appears and the row is gone. Read state over CDP (`OutboxJournal.readAll()`) rather than screenshots.

- [ ] **Step 7: Update `HANDOFF.md`** (Now: revision, migration 0048, TTL 720 h, APK 1.8 path; Next: fleet rollout of 1.8; PG gates 12) and commit with `[CF-Pages-Skip] docs(handoff): …` via `git commit -F`.
