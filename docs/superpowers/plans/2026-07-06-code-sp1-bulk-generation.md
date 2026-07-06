# SP-Code-1 Bulk Discount-Code Generation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Generate a batch of N unique discount codes at once (shared settings) via a new server-side endpoint + a backoffice "Buat Massal" modal that downloads the batch as CSV.

**Architecture:** A new `POST /api/v1/discount-codes/batch` endpoint generates each code server-side (prefix + unambiguous random suffix) and inserts it, retrying on the `UNIQUE(code)` collision, in one tx; returns the created rows. A backoffice modal collects count/prefix/length + the shared code settings and downloads the result.

**Tech Stack:** Go (backend: pgx tx, crypto/rand), TypeScript (hand-written `@mandalika/api` client; backoffice React), oapi-codegen + openapi-typescript.

**Spec:** `docs/superpowers/specs/2026-07-06-code-sp1-bulk-generation-design.md`

## Global Constraints

- **Server-side generation only** (collision-safe against `UNIQUE(code)`). Suffix charset **`ABCDEFGHJKLMNPQRSTUVWXYZ23456789`** (no `O/0/1/I`), via `crypto/rand`.
- **Bounds:** `1 ≤ count ≤ 500`; `4 ≤ suffixLength ≤ 12`; `prefix` uppercase-alphanumeric, length ≤ 16; `type ∈ {percentage,fixed}`.
- Code = `strings.ToUpper(prefix) + randSuffix(suffixLength)`. All codes in a batch share type/value/minPurchase/usageLimit/startDate/endDate/combinable/promotionId; only the string differs.
- **Atomic:** one tx; on a per-code collision, regenerate the suffix + retry (bounded, 10/code); if still colliding, abort the whole tx → error (never partial).
- Permission **`manage_promotions`** (same as the single-code writes).
- **No migration** (reuses `discount_codes`), no POS/APK. Deploy = backend redeploy + Cloudflare backoffice.
- Money-adjacent + type-gen + a collision/tx path → **Opus** review on the repo (Task 1) + codegen (Task 2); Sonnet elsewhere.
- Don't touch unrelated working-tree files (`package.json` doctor script, PNGs, audit doc).

## File Structure
- `backend/internal/write/repo.go` — MODIFY: `DiscountCodeBatch` struct, `CreatedCode` struct, `randSuffix` helper, `CreateDiscountCodeBatch`, `validateDiscountCodeBatch`.
- `backend/internal/write/repo_test.go` — MODIFY/CREATE: `randSuffix` + validation tests.
- `backend/api/openapi.yaml` + regen `api.gen.go`, `packages/api/src/schema.d.ts` — `DiscountCodeBatchInput` + path.
- `backend/internal/handlers/writes.go` — MODIFY: `CreateDiscountCodeBatch` handler.
- `backend/internal/server/server.go` — MODIFY: route.
- `packages/api/src/client.ts` — MODIFY: `createDiscountCodeBatch`.
- `apps/backoffice/src/screens/promotions/DiscountCodeBatchModal.tsx` — CREATE.
- `apps/backoffice/src/screens/Promotions.tsx` — MODIFY: "Buat Massal" button + modal wiring + CSV download.
- `backend/cmd/codebatch/main.go` — CREATE throwaway (Task 6, never committed).

---

## Task 1: Backend — batch repo, generation, validation

**Files:**
- Modify: `backend/internal/write/repo.go` (near `CreateDiscountCode` ~L742)
- Test: `backend/internal/write/repo_test.go`

**Interfaces:**
- Produces:
  - `type DiscountCodeBatch struct { DiscountCode; Count int; Prefix string; SuffixLength int }` (embeds the existing `DiscountCode` for the shared settings; `Code` on the embedded struct is unused/ignored).
  - `type CreatedCode struct { ID, Code, CreatedAt string }`
  - `func (r *Repo) CreateDiscountCodeBatch(ctx context.Context, b DiscountCodeBatch) ([]CreatedCode, error)`
  - `func validateDiscountCodeBatch(b DiscountCodeBatch) error`
- Consumes: `r.Pool` (via `r.tx` or a direct `Pool.Begin`), `nullUUID`, `nullDate`.

- [ ] **Step 1: Write failing tests**

```go
func TestRandSuffix(t *testing.T) {
	const bad = "O01I"
	for i := 0; i < 200; i++ {
		s := randSuffix(8)
		if len(s) != 8 {
			t.Fatalf("len: want 8, got %d (%q)", len(s), s)
		}
		for _, c := range s {
			if strings.ContainsRune(bad, c) {
				t.Fatalf("ambiguous char %q in %q", c, s)
			}
			if !strings.ContainsRune("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", c) {
				t.Fatalf("unexpected char %q in %q", c, s)
			}
		}
	}
}

func TestValidateDiscountCodeBatch(t *testing.T) {
	ok := DiscountCodeBatch{DiscountCode: DiscountCode{Type: "percentage", Value: 10}, Count: 10, SuffixLength: 6}
	if err := validateDiscountCodeBatch(ok); err != nil {
		t.Fatalf("valid rejected: %v", err)
	}
	bad := []DiscountCodeBatch{
		{DiscountCode: DiscountCode{Type: "percentage", Value: 10}, Count: 0, SuffixLength: 6},   // count<1
		{DiscountCode: DiscountCode{Type: "percentage", Value: 10}, Count: 501, SuffixLength: 6}, // count>500
		{DiscountCode: DiscountCode{Type: "percentage", Value: 10}, Count: 10, SuffixLength: 3},  // suffix<4
		{DiscountCode: DiscountCode{Type: "percentage", Value: 10}, Count: 10, SuffixLength: 13}, // suffix>12
		{DiscountCode: DiscountCode{Type: "bogus", Value: 10}, Count: 10, SuffixLength: 6},       // bad type
		{DiscountCode: DiscountCode{Type: "percentage", Value: 10}, Count: 10, SuffixLength: 6, Prefix: "toolongprefixxxxx!"}, // prefix invalid
	}
	for i, b := range bad {
		if err := validateDiscountCodeBatch(b); err == nil {
			t.Fatalf("case %d: expected error", i)
		}
	}
}
```

- [ ] **Step 2: Run, verify fail**

Run: `cd backend && go test ./internal/write/ -run 'TestRandSuffix|TestValidateDiscountCodeBatch' -v`
Expected: FAIL (undefined `randSuffix`, `validateDiscountCodeBatch`, `DiscountCodeBatch`).

- [ ] **Step 3: Implement the structs + helpers** (repo.go, after `CreateDiscountCode`)

```go
const codeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789" // no O,0,1,I

// randSuffix returns a length-n string over codeAlphabet using crypto/rand
// (unbiased rejection sampling is overkill for a 32-char alphabet; simple mod
// bias here is negligible, but use a bounded read for determinism).
func randSuffix(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		// crypto/rand should never fail; fall back so batch generation can't wedge.
		for i := range b {
			b[i] = byte(i)
		}
	}
	out := make([]byte, n)
	for i, x := range b {
		out[i] = codeAlphabet[int(x)%len(codeAlphabet)]
	}
	return string(out)
}

type DiscountCodeBatch struct {
	DiscountCode
	Count        int    `json:"count"`
	Prefix       string `json:"prefix"`
	SuffixLength int    `json:"suffixLength"`
}

type CreatedCode struct {
	ID        string `json:"id"`
	Code      string `json:"code"`
	CreatedAt string `json:"createdAt"`
}

var prefixRe = regexp.MustCompile(`^[A-Z0-9]*$`)

func validateDiscountCodeBatch(b DiscountCodeBatch) error {
	if b.Count < 1 || b.Count > 500 {
		return fmt.Errorf("count must be 1..500")
	}
	if b.SuffixLength < 4 || b.SuffixLength > 12 {
		return fmt.Errorf("suffixLength must be 4..12")
	}
	if len(b.Prefix) > 16 || !prefixRe.MatchString(strings.ToUpper(b.Prefix)) {
		return fmt.Errorf("prefix must be alphanumeric, max 16 chars")
	}
	if b.Type != "percentage" && b.Type != "fixed" {
		return fmt.Errorf("type must be percentage or fixed")
	}
	return nil
}
```
NOTE: add imports `crypto/rand` (aliased `rand`), `regexp`, `strings`, `fmt` (some already present — check the file's import block; `crypto/rand` may clash with an existing `math/rand` import — if so alias `crand "crypto/rand"` and use `crand.Read`).

- [ ] **Step 4: Implement `CreateDiscountCodeBatch`** (repo.go)

```go
func (r *Repo) CreateDiscountCodeBatch(ctx context.Context, b DiscountCodeBatch) ([]CreatedCode, error) {
	if err := validateDiscountCodeBatch(b); err != nil {
		return nil, err
	}
	prefix := strings.ToUpper(b.Prefix)
	out := make([]CreatedCode, 0, b.Count)
	err := r.tx(ctx, "discountCodes", func(t pgx.Tx) error {
		for i := 0; i < b.Count; i++ {
			var id, code, createdAt string
			inserted := false
			for attempt := 0; attempt < 10 && !inserted; attempt++ {
				code = prefix + randSuffix(b.SuffixLength)
				e := t.QueryRow(ctx, `
					INSERT INTO discount_codes (code, promotion_id, type, value,
					  min_purchase, usage_limit, is_active, start_date, end_date, combinable)
					VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
					RETURNING id, code, created_at::text`,
					code, nullUUID(b.PromotionID), b.Type, b.Value, b.MinPurchase,
					b.UsageLimit, b.IsActive, nullDate(b.StartDate), nullDate(b.EndDate), b.Combinable).
					Scan(&id, &code, &createdAt)
				if e == nil {
					inserted = true
					break
				}
				var pgErr *pgconn.PgError
				if errors.As(e, &pgErr) && pgErr.Code == "23505" { // unique_violation → regenerate
					continue
				}
				return e // other error → abort tx
			}
			if !inserted {
				return fmt.Errorf("could not generate a unique code after retries")
			}
			out = append(out, CreatedCode{ID: id, Code: code, CreatedAt: createdAt})
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}
```
NOTE: confirm `r.tx(ctx, name, fn)` runs `fn` inside a single tx and rolls back if `fn` returns an error (it's used by CreateDiscountCode). Confirm `pgconn` is imported (add `github.com/jackc/pgx/v5/pgconn`) and `errors`. If the INSERT's `RETURNING created_at::text` format needs to match the read side's ISO form, `to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')` matches the read repo's convention — use that if the UI parses it; otherwise `::text` is fine for the CSV.

- [ ] **Step 5: Run tests, verify pass + build**

Run: `cd backend && go test ./internal/write/ -run 'TestRandSuffix|TestValidateDiscountCodeBatch' -v && go build ./...`
Expected: PASS + clean build.

- [ ] **Step 6: Commit**

```bash
git add backend/internal/write/repo.go backend/internal/write/repo_test.go
git commit -m "feat(code-sp1): batch discount-code repo — collision-safe server-side generation + validation"
```

---

## Task 2: OpenAPI `DiscountCodeBatchInput` + path + regen

**Files:**
- Modify: `backend/api/openapi.yaml` (near `DiscountCodeInput` ~L1775)
- Regenerate: `api.gen.go`, `schema.d.ts`

**Interfaces:**
- Produces: `DiscountCodeBatchInput` schema; `POST /api/v1/discount-codes/batch` → `DiscountCodeListResponse`; generated Go/TS types.

- [ ] **Step 1: Add the schema** (openapi.yaml, after `DiscountCodeInput`)

Copy the `DiscountCodeInput` property block (type/value/minPurchase/usageLimit/isActive/startDate/endDate/combinable/promotionId) MINUS `code`, and add `count`, `prefix`, `suffixLength`:
```yaml
    DiscountCodeBatchInput:
      type: object
      required: [type, value, count]
      properties:
        count: { type: integer }
        prefix: { type: string }
        suffixLength: { type: integer }
        type: { type: string, enum: [percentage, fixed] }
        value: { type: number }
        minPurchase: { type: number, nullable: true }
        usageLimit: { type: integer, nullable: true }
        isActive: { type: boolean }
        startDate: { type: string, nullable: true }
        endDate: { type: string, nullable: true }
        combinable: { type: boolean, nullable: true }
        promotionId: { type: string, nullable: true }
```
(Match the exact nullability/shape of the real `DiscountCodeInput` fields — open it and mirror.)

- [ ] **Step 2: Add the path** (openapi.yaml, near the other `discount-codes` paths)

```yaml
  /api/v1/discount-codes/batch:
    post:
      summary: Generate a batch of discount codes
      operationId: createDiscountCodeBatch
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/DiscountCodeBatchInput' }
      responses:
        '200':
          description: Created codes
          content:
            application/json:
              schema: { $ref: '#/components/schemas/DiscountCodeListResponse' }
```
(Match the `/api/v1/` prefix + tags/security style of a sibling `discount-codes` path.)

- [ ] **Step 3: Regenerate + verify**

Run:
```bash
cd backend && make gen-go
corepack pnpm@10.11.1 --filter @mandalika/api gen
cd backend && make gen-check && go build ./...
```
Expected: gen-check clean; `grep -n "DiscountCodeBatchInput" backend/internal/api/api.gen.go packages/api/src/schema.d.ts` shows the Go struct + TS type.

- [ ] **Step 4: Commit**

```bash
git add backend/api/openapi.yaml backend/internal/api/api.gen.go packages/api/src/schema.d.ts
git commit -m "feat(code-sp1): OpenAPI DiscountCodeBatchInput + /discount-codes/batch, regen clients"
```

---

## Task 3: Handler + route

**Files:**
- Modify: `backend/internal/handlers/writes.go` (near `CreateDiscountCode` ~L172)
- Modify: `backend/internal/server/server.go` (the `manage_promotions` discount-code group ~L183)

**Interfaces:**
- Consumes: `write.CreateDiscountCodeBatch`, `write.DiscountCodeBatch`, `decodeWrite`, `writeJSON`, `api.DiscountCode`/`api.DiscountCodeListResponse`.
- Produces: `func (h *Handlers) CreateDiscountCodeBatch(...)`; route `POST /discount-codes/batch`.

- [ ] **Step 1: Add the handler** (writes.go)

```go
func (h *Handlers) CreateDiscountCodeBatch(w http.ResponseWriter, r *http.Request) {
	b, ok := decodeWrite[write.DiscountCodeBatch](w, r)
	if !ok {
		return
	}
	created, err := h.Write.CreateDiscountCodeBatch(r.Context(), b)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err) // validation → 400; else surfaces the message
		return
	}
	// Assemble the API rows from the shared settings + each generated (id, code).
	rows := make([]api.DiscountCode, len(created))
	for i, c := range created {
		rows[i] = api.DiscountCode{
			Id: c.ID, Code: c.Code, Type: b.Type, Value: float32(b.Value),
			UsageLimit: b.UsageLimit, IsActive: b.IsActive, Combinable: &b.Combinable,
			// map the remaining fields (minPurchase/dates/promotionId/createdAt) to the
			// generated api.DiscountCode shape — match the field names/types in api.gen.go.
		}
	}
	writeJSON(w, http.StatusOK, api.DiscountCodeListResponse{Data: rows})
}
```
NOTE: the exact `api.DiscountCode` field names/pointer-ness come from `api.gen.go` (grep `type DiscountCode struct`). Fill in every field from `b` + `c` (id/code/createdAt from `CreatedCode`, the rest from `b`). If assembling is fiddly, an equally-fine alternative: return only the codes the UI needs by having the repo return them and responding with a minimal shape — but `DiscountCodeListResponse` keeps it consistent, so prefer assembling. `CreatedCode.ID`/`.Code`/`.CreatedAt` are the repo's (Task 1) fields.

- [ ] **Step 2: Register the route** (server.go, in the `manage_promotions` group with the other discount-code POSTs ~L183)

```go
				r.Post("/discount-codes/batch", h.CreateDiscountCodeBatch)
```

- [ ] **Step 3: Build**

Run: `cd backend && go build ./... && go vet ./internal/handlers/`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add backend/internal/handlers/writes.go backend/internal/server/server.go
git commit -m "feat(code-sp1): CreateDiscountCodeBatch handler + /discount-codes/batch route (manage_promotions)"
```

---

## Task 4: Client `createDiscountCodeBatch`

**Files:**
- Modify: `packages/api/src/client.ts` (the `Api` interface + `createClient`, near `createDiscountCode`)

**Interfaces:**
- Consumes: `components['schemas']['DiscountCodeBatchInput']`, `DiscountCode`; `request<T>`.
- Produces: `api.createDiscountCodeBatch(input) => Promise<DiscountCode[]>`.

- [ ] **Step 1: Add the type alias + interface method + impl**

Type alias (near the other `components['schemas']` aliases): `type DiscountCodeBatchInput = components['schemas']['DiscountCodeBatchInput']`.
`Api` interface (near `createDiscountCode`):
```ts
  createDiscountCodeBatch: (input: DiscountCodeBatchInput) => Promise<DiscountCode[]>
```
Impl in `createClient`:
```ts
    createDiscountCodeBatch: (input) =>
      request<{ data: DiscountCode[] }>('POST', `${API}/discount-codes/batch`, input).then((r) => r.data),
```
NOTE: confirm `request`/`API` names (see how `createDiscountCode`/`listDiscountCodes` are written); the handler returns `{ data: [...] }`, so unwrap `.data`.

- [ ] **Step 2: Verify + commit**

Run: `cd apps/backoffice && corepack pnpm tsc --noEmit`
Expected: clean.
```bash
git add packages/api/src/client.ts
git commit -m "feat(code-sp1): client createDiscountCodeBatch"
```

---

## Task 5: Backoffice — "Buat Massal" modal + button + CSV

**Files:**
- Create: `apps/backoffice/src/screens/promotions/DiscountCodeBatchModal.tsx`
- Modify: `apps/backoffice/src/screens/Promotions.tsx`

**Interfaces:**
- Consumes: `api.createDiscountCodeBatch`; `exportToCSV` from `../../lib/csvUtils`; the existing `DiscountCodeFormModal` field patterns (`Input`/`Select`/`Field`); the codes list refetch `dcq`.
- Produces: a batch modal + a "Buat Massal" trigger on the Kode Diskon tab.

- [ ] **Step 1: Build `DiscountCodeBatchModal.tsx`** (mirror `DiscountCodeFormModal.tsx`)

Props: `{ open, busy, promotions, onGenerate(input), onClose }`. Local `form` state (a `DiscountCodeBatchInput`-shaped object) defaulting to `{ count: 10, prefix: '', suffixLength: 6, type: 'percentage', value: 0, minPurchase: 0, usageLimit: 1, isActive: true, combinable: false, promotionId: undefined }`. Fields: **Jumlah** (count, `min={1} max={500}`), **Prefix** (text, uppercased), **Panjang kode** (suffixLength, `min={4} max={12}`), + the shared settings reused from the single-code form (Tautkan ke promosi `Select`, Tipe, Nilai, Min. Beli, **Batas Pakai per kode** default 1, Mulai/Berakhir dates, Bisa Kombinasi). Client-side guard (block the Generate button): count 1–500, suffixLength 4–12, type set. Footer: Batal + "Generate" (calls `onGenerate(form)`, `loading={busy}`).

- [ ] **Step 2: Wire into `Promotions.tsx`**

- Add a "Buat Massal" button on the Kode Diskon tab header, next to "Tambah Kode" (the header ~L250-253). Add `const [batchOpen, setBatchOpen] = useState(false)`.
- A handler:
```tsx
  const generateBatch = async (input: DiscountCodeBatchInput) => {
    setCodeBusy(true) // reuse or add a busy flag
    try {
      const created = await api.createDiscountCodeBatch(input)
      await dcq.refetch?.()  // or however the list re-polls; else rely on the poll interval
      setBatchOpen(false)
      showToast?.(`${created.length} kode dibuat`)  // match the app's toast mechanism
      exportToCSV(created.map((c) => ({ Kode: c.code, Tipe: c.type, Nilai: c.value, Kuota: c.usageLimit ?? 0 })), `kode-batch`)
    } catch (e) {
      // surface the error (match how the single-code save shows errors)
    } finally {
      setCodeBusy(false)
    }
  }
```
- Render `<DiscountCodeBatchModal open={batchOpen} busy={codeBusy} promotions={promotions} onGenerate={generateBatch} onClose={() => setBatchOpen(false)} />`.
NOTE: match the app's real toast/refetch/error patterns (check how `saveCode`/`exportDiscountCodes` do it in this file); `exportToCSV`'s signature is in `csvUtils.ts` — match it (it's used by `exportDiscountCodes`).

- [ ] **Step 3: Verify + commit**

Run: `cd apps/backoffice && corepack pnpm tsc --noEmit && corepack pnpm vite build`
Expected: clean.
```bash
git add apps/backoffice/src/screens/promotions/DiscountCodeBatchModal.tsx apps/backoffice/src/screens/Promotions.tsx
git commit -m "feat(code-sp1): backoffice Buat Massal batch modal + CSV download"
```

---

## Task 6: Verify — live e2e, deploy, handoff

**Files:**
- Create (throwaway, NEVER commit): `backend/cmd/codebatch/main.go`

- [ ] **Step 1: Local gate**

Run: `cd backend && go build ./... && go test ./... && make gen-check` ; `cd apps/backoffice && corepack pnpm tsc --noEmit && corepack pnpm vite build`
Expected: all green.

- [ ] **Step 2: Throwaway live e2e** (`cmd/codebatch`, real `write.Repo`, zero-residue, deleted after)

Connect via `config.Load()`→`db.Connect`→`write.New(pool)` (mirror `cmd/seed`). Assert:
1. `CreateDiscountCodeBatch({Count:5, Prefix:"E2EBATCH", SuffixLength:6, Type:"percentage", Value:10, UsageLimit:1})` → 5 rows, all codes start with `E2EBATCH`, all unique, suffix chars ∈ the unambiguous set, each persisted with value 10 / usageLimit 1.
2. **Collision retry:** pre-insert a code equal to a forced suffix (or generate a batch, then a second identical-settings batch of Count:20 with the same prefix) → still creates the requested count (retries around collisions), zero duplicates.
3. Cleanup: `DELETE FROM discount_codes WHERE code LIKE 'E2EBATCH%'` + self-check zero residue. Then `rm -rf backend/cmd/codebatch`.
Run vs Neon via the [[neon-e2e-verification]] secret-injection (`DATABASE_URL="$(gcloud secrets versions access latest --secret=DATABASE_URL)" go run ./cmd/codebatch`) if the user authorizes writing to Neon; else local dev Postgres (note which).

- [ ] **Step 3: Push + deploy** (no migration)

`git push origin prod-hardening` (retry on the reset gotcha) → `gcloud run deploy mandalika-pos --source backend --region asia-southeast2` → `/readyz` 200. Cloudflare backoffice auto-deploys.

- [ ] **Step 4: Live authed smoke** (per [[neon-e2e-verification]])

Admin token → `POST /api/v1/discount-codes/batch` `{count:3, prefix:"SMOKE", suffixLength:6, type:"percentage", value:5, usageLimit:1}` → 200 with 3 codes; `GET /discount-codes` shows them; then DELETE the 3 (or via the UI) — zero residue on the test DB.

- [ ] **Step 5: Handoff + memory**

Update the discount-code memory + `MEMORY.md` + `SESSION_HANDOFF.md`: SP-Code-1 done (bulk gen); next = SP-Code-2 (analytics). Commit + push the handoff.

---

## Notes for the implementer
- **Task 1 is the crux** (collision-safe generation in a tx). The `23505` retry + whole-tx-abort-on-exhaustion is the correctness point — Opus review. The live e2e (Task 6) proves it against a real unique index.
- **Handler assembly** (Task 3): fill EVERY `api.DiscountCode` field from `b`+`CreatedCode`, matching the generated struct's exact field names/pointer types (grep `type DiscountCode struct` in api.gen.go).
- No migration, no POS/APK.
