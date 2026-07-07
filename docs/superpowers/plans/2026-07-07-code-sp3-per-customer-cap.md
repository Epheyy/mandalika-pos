# SP-Code-3 Per-Customer Discount-Code Redemption Cap — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Cap how many times a single customer may redeem a discount code (`per_customer_limit`), enforced with a local POS requires-customer guard + a server-authoritative count under the existing code-row lock.

**Architecture:** A nullable `per_customer_limit` on `discount_codes`. Two enforcement layers: (a) *requires-a-customer* in the SHARED validator (`ValidateCode` Go + `validateCode` TS) so the POS greys the code and the server backstops it via the existing hybrid; (b) the *count* ("already at the cap?") is server-only inside `resolvePromos`, under the `FOR UPDATE` code-row lock already held through `usage_count++`, counted over completed orders' `applied_discount_codes` against the merged-keeper customer id.

**Tech Stack:** Go (pgx, `internal/service`), TypeScript (POS pure validator + React backoffice), oapi-codegen + openapi-typescript.

**Spec:** `docs/superpowers/specs/2026-07-07-code-sp3-per-customer-cap-design.md`

## Global Constraints
- **Cap scope = GLOBAL** across outlets (no outlet filter in the count) — parallels the global `usage_limit`.
- **`per_customer_limit` is nullable, independent of `usage_limit`**; `NULL` = uncapped per-customer.
- **Requires-customer** = shared validator (`ValidateCode`/`validateCode`): `perCustomerLimit != null && !hasCustomer` → `ViolationRequiresCustomer`. Rides the existing online-reject / offline-flag hybrid.
- **Count** = server-only, inside `resolvePromos` after the code row loads `FOR UPDATE` (order.go:868–871), BEFORE the linked/unlinked branch. Completed-only (`status='completed'`), counted against the **merged-keeper** id (`resolveMergedCustomer`). `>= per_customer_limit` → `ViolationPerCustomerCapReached`.
- **Server-authoritative:** online violation → 422 `ErrDiscountRejected`; offline → keep order + `discount_warning` flag (append to `violations`).
- **Messages (verbatim):** requires-customer → **"Kode ini butuh pelanggan terdaftar"**; cap-reached → **"Pelanggan sudah mencapai batas pemakaian kode ini"**; POS grey reason for requires-customer → **"Pilih pelanggan dulu untuk kode ini"**.
- **Gap-class rule:** adding a column = trace the READ json (`DiscountCodes` + `DiscountCodesByIDs`) AND every WRITE (single INSERT + UPDATE + batch INSERT) AND OpenAPI AND both forms (SP-Promo-3a lesson).
- Migration **0042**. POS changes → **APK**. Don't touch pre-existing unrelated working-tree files.
- Model routing: engine (order.go/resolvePromos/validator) + type-gen → **Opus**; repo wiring → Opus review (gap-class); TS/backoffice → Sonnet.

## File Structure
- `backend/internal/db/migrations/0042_discount_code_per_customer_limit.sql` — CREATE.
- `backend/api/openapi.yaml` + regen — `perCustomerLimit` on `DiscountCode` + code input + batch input.
- `backend/internal/service/promo_validate.go` — `CodeRow.PerCustomerLimit`, `PromoEvalContext.HasCustomer`+`CustomerID`, two new violation consts, `ValidateCode` rule.
- `backend/internal/service/order.go` — set ctx fields (:146), SELECT `per_customer_limit` (:869), the count block.
- `backend/internal/handlers/writes.go` — violation→message cases (:1424 switch) + `promo_message_test.go`.
- `backend/internal/write/repo.go` — code write struct + INSERT (:748) + UPDATE (:873) + batch INSERT (SP-Code-1 `CreateDiscountCodeBatch`).
- `backend/internal/read/repo.go` — `DiscountCodes` (:850) + `DiscountCodesByIDs` (:865) json.
- `apps/pos/src/cashier/promoValidate.ts` (+ `promoValidate.test.ts`) — `hasCustomer`, `requires_customer`, guard, reason.
- `apps/pos/src/cashier/CashierScreen.tsx` — pass `hasCustomer` into the validator ctx.
- `apps/backoffice/src/screens/promotions/*` — code form + `DiscountCodeBatchModal.tsx`.
- `backend/cmd/codepercust/main.go` — throwaway (Task 7).

---

## Task 1: Migration 0042 + OpenAPI field + regen

**Files:** Create migration; modify `backend/api/openapi.yaml`; regen `api.gen.go`, `schema.d.ts`.

**Interfaces:** Produces DB column `discount_codes.per_customer_limit int`; API field `perCustomerLimit` (nullable int) on `DiscountCode`, the code create/update input, and the batch-create input.

- [ ] **Step 1: Migration**

Create `backend/internal/db/migrations/0042_discount_code_per_customer_limit.sql`:
```sql
ALTER TABLE discount_codes ADD COLUMN per_customer_limit integer;
```

- [ ] **Step 2: OpenAPI** — add to the `DiscountCode` schema, the discount-code input schema, AND the batch-create input schema (the SP-Code-1 batch body — grep `discount-codes/batch` in openapi.yaml for its request schema):
```yaml
        perCustomerLimit:
          type: integer
          nullable: true
```
(Add the identical 3-line block to each of the 3 schemas. Match indentation of the sibling `usageLimit`.)

- [ ] **Step 3: Regen + verify**
```bash
cd backend && make gen-go && cd ..
corepack pnpm@10.11.1 --filter @mandalika/api gen
cd backend && make gen-check && go build ./...
```
Expected: gen-check clean after commit; `grep -n PerCustomerLimit backend/internal/api/api.gen.go` shows `nullable.Nullable[int]` on the `DiscountCode` struct (and the input structs); `grep -n perCustomerLimit packages/api/src/schema.d.ts` shows `number | null`.

- [ ] **Step 4: Commit**
```bash
git add backend/internal/db/migrations/0042_discount_code_per_customer_limit.sql backend/api/openapi.yaml backend/internal/api/api.gen.go packages/api/src/schema.d.ts
git commit -m "feat(code-sp3): migration 0042 per_customer_limit + OpenAPI perCustomerLimit, regen"
```

---

## Task 2: Shared validator — requires-customer rule

**Files:** Modify `backend/internal/service/promo_validate.go`, `order.go`, `handlers/writes.go`, `handlers/promo_message_test.go`, `promo_validate_test.go`.

**Interfaces:**
- Produces: `CodeRow.PerCustomerLimit *int`; `PromoEvalContext.HasCustomer bool` + `PromoEvalContext.CustomerID string`; consts `ViolationRequiresCustomer` (`"requires_customer"`) + `ViolationPerCustomerCapReached` (`"per_customer_cap_reached"`); `ValidateCode` appends `ViolationRequiresCustomer` when `c.PerCustomerLimit != nil && !ec.HasCustomer`.
- Consumes: existing `ValidateCode(c CodeRow, ec PromoEvalContext) []PromoViolation`.

- [ ] **Step 1: Failing unit test** — add to `promo_validate_test.go`'s `ValidateCode` table (near line 60):
```go
{"requires customer (capped, no customer)", CodeRow{PerCustomerLimit: iptr(1)}, base, []PromoViolation{ViolationRequiresCustomer}},
{"capped with customer ok", CodeRow{PerCustomerLimit: iptr(1)}, baseWithCustomer, nil},
{"uncapped no customer ok", CodeRow{}, base, nil},
```
Add a `baseWithCustomer := base; baseWithCustomer.HasCustomer = true` local near `base` in that test (or inline a `PromoEvalContext{...HasCustomer:true}`). `iptr` already exists in this test file.

- [ ] **Step 2: Run — fails to compile** (`PerCustomerLimit`/`HasCustomer`/`ViolationRequiresCustomer` undefined):
```bash
cd backend && go test ./internal/service/ -run TestValidateCode 2>&1 | head
```
Expected: build error (undefined symbols).

- [ ] **Step 3: Implement** in `promo_validate.go`:
  - Consts block (near line 14–20): add
```go
	ViolationRequiresCustomer      PromoViolation = "requires_customer"
	ViolationPerCustomerCapReached PromoViolation = "per_customer_cap_reached"
```
  - `PromoEvalContext` struct (line 32): add fields
```go
	HasCustomer bool
	CustomerID  string
```
  - `CodeRow` struct (line 47): add `PerCustomerLimit *int`.
  - `ValidateCode` (line 124): before `return v`, add
```go
	if c.PerCustomerLimit != nil && !ec.HasCustomer {
		v = append(v, ViolationRequiresCustomer)
	}
```

- [ ] **Step 4: Wire the context + SELECT in order.go**
  - `order.go:146` — set the new ctx fields:
```go
	promoEvalCtx := PromoEvalContext{SaleTimeWIB: saleTime.In(wib), OutletID: in.OutletID, Subtotal: promoSubtotal, HasCustomer: in.CustomerID != "", CustomerID: in.CustomerID}
```
  - `order.go:869` — add `per_customer_limit` to the code SELECT and scan into `row.PerCustomerLimit`:
```go
		err := tx.QueryRow(ctx,
			`SELECT id, promotion_id, type, value, start_date, end_date, min_purchase, usage_limit, usage_count, combinable, per_customer_limit
			   FROM discount_codes WHERE code=$1 AND is_active=true FOR UPDATE`, code).
			Scan(&id, &promotionID, &kind, &value, &row.StartDate, &row.EndDate, &row.MinPurchase, &row.UsageLimit, &row.UsageCount, &row.Combinable, &row.PerCustomerLimit)
```

- [ ] **Step 5: Message map** in `handlers/writes.go` (the switch at ~line 1424) — add cases:
```go
	case service.ViolationRequiresCustomer:
		return "Kode ini butuh pelanggan terdaftar"
	case service.ViolationPerCustomerCapReached:
		return "Pelanggan sudah mencapai batas pemakaian kode ini"
```
And add two rows to `handlers/promo_message_test.go`'s table:
```go
		{"requires customer", []service.PromoViolation{service.ViolationRequiresCustomer}, "Kode ini butuh pelanggan terdaftar"},
		{"per-customer cap", []service.PromoViolation{service.ViolationPerCustomerCapReached}, "Pelanggan sudah mencapai batas pemakaian kode ini"},
```

- [ ] **Step 6: Run tests + build**
```bash
cd backend && go test ./internal/service/ ./internal/handlers/ && go build ./...
```
Expected: PASS.

- [ ] **Step 7: Commit**
```bash
git add backend/internal/service/promo_validate.go backend/internal/service/promo_validate_test.go backend/internal/service/order.go backend/internal/handlers/writes.go backend/internal/handlers/promo_message_test.go
git commit -m "feat(code-sp3): requires-customer rule in shared validator + per-customer violation messages"
```

---

## Task 3: Server-only per-customer count

**Files:** Modify `backend/internal/service/order.go` (`resolvePromos`, after the code row loads).

**Interfaces:** Consumes `row.PerCustomerLimit`, `ec.HasCustomer`, `ec.CustomerID`, `resolveMergedCustomer(ctx, tx, id) (string, error)`, `ViolationPerCustomerCapReached`. Produces the appended violation on `codeVio` before the linked/unlinked branch.

- [ ] **Step 1: Implement the count** — in `resolvePromos`, immediately AFTER `codeVio := ValidateCode(row, ec)` (order.go:883) and BEFORE the `if promotionID != nil` linked branch (order.go:886), insert:
```go
		// SP-Code-3: server-only per-customer cap. (requires-customer already handled
		// by ValidateCode above.) Counted under the FOR UPDATE code-row lock held from
		// the SELECT above through usage_count++ later in this tx, so it's race-safe.
		if row.PerCustomerLimit != nil && ec.HasCustomer {
			keeper, kerr := resolveMergedCustomer(ctx, tx, ec.CustomerID)
			if kerr != nil {
				keeper = ec.CustomerID // fall back to the raw id
			}
			var used int
			if e := tx.QueryRow(ctx,
				`SELECT count(*) FROM orders
				   WHERE customer_id = $1 AND status = 'completed'
				     AND jsonb_exists(COALESCE(applied_discount_codes, '[]'::jsonb), $2)`,
				keeper, code).Scan(&used); e != nil {
				return nil, nil, nil, "", fmt.Errorf("count per-customer redemptions: %w", e)
			}
			if used >= *row.PerCustomerLimit {
				codeVio = append(codeVio, ViolationPerCustomerCapReached)
			}
		}
```
NOTE: `jsonb_exists(arr, $2)` is the function form of the jsonb `?` operator (avoids any `?`-placeholder ambiguity in pgx); `applied_discount_codes` is a jsonb array of code strings, so this is true iff `code` is an element. `codeVio` is consumed by BOTH the linked path (`combinedViolations(codeVio, pvio)`) and the unlinked path (`if len(codeVio) > 0`), so appending here covers both.

- [ ] **Step 2: Build + existing tests**
```bash
cd backend && go build ./... && go vet ./internal/service/ && go test ./internal/service/
```
Expected: clean (this DB-dependent count has no unit harness; it is proven by the Task-7 live e2e — do NOT add a throwaway test here).

- [ ] **Step 3: Commit**
```bash
git add backend/internal/service/order.go
git commit -m "feat(code-sp3): server-only per-customer redemption count under FOR UPDATE (completed-only, merged-keeper)"
```

---

## Task 4: POS validator parity (TS)

**Files:** Modify `apps/pos/src/cashier/promoValidate.ts` (+ `promoValidate.test.ts`), `apps/pos/src/cashier/CashierScreen.tsx`.

**Interfaces:** `PromoEvalContext` (TS) gains `hasCustomer: boolean`; `Violation` union gains `'requires_customer'`; `validateCode` appends it when `c.perCustomerLimit != null && !ctx.hasCustomer`; `violationMessage['requires_customer'] = 'Pilih pelanggan dulu untuk kode ini'`.

- [ ] **Step 1: Failing vitest** — add to `promoValidate.test.ts` (the `validateCode` cases near line 60–68):
```ts
{ name: 'requires customer when capped + no customer', row: { perCustomerLimit: 1 }, want: ['requires_customer'] },
```
And ensure the test's shared `ctx` sets `hasCustomer: false` (add the field to the base ctx object in that file). Add a positive case with a per-test ctx `{...base, hasCustomer: true}` expecting `[]`.

- [ ] **Step 2: Run — fails**
```bash
cd apps/pos && corepack pnpm vitest run src/cashier/promoValidate.test.ts 2>&1 | tail
```
Expected: FAIL (type error on `hasCustomer`/`perCustomerLimit`, or assertion).

- [ ] **Step 3: Implement** in `promoValidate.ts`:
  - `Violation` union (line ~16): add `| 'requires_customer'`.
  - `PromoEvalContext` interface (line ~26): add `hasCustomer: boolean`.
  - `validateCode` (after the `usage_limit_reached` push, ~line 79): add
```ts
  if (c.perCustomerLimit != null && !ctx.hasCustomer) v.push('requires_customer')
```
  - `violationMessage` map (line ~87): add
```ts
  requires_customer: 'Pilih pelanggan dulu untuk kode ini',
```

- [ ] **Step 4: Pass `hasCustomer` into the validator ctx** — in `CashierScreen.tsx`, find where the `PromoEvalContext` object is built for the code-apply path (grep for `outletId:` + `subtotal:` object literal, near the `decideApplyCode`/`setPromoCodeError` usage ~line 678). Add `hasCustomer: <cart has a selected customer>` using the same source `useCart` exposes (the cart's `selectedCustomer !== null`). If a shared `buildPromoCtx` helper exists, add it there so both promo and code paths get it.

- [ ] **Step 5: Run vitest + tsc + build**
```bash
cd apps/pos && corepack pnpm vitest run src/cashier/promoValidate.test.ts && corepack pnpm tsc --noEmit && corepack pnpm vite build
```
Expected: PASS + clean. (Fix any other call site that constructs `PromoEvalContext` and now needs `hasCustomer` — tsc will name them.)

- [ ] **Step 6: Commit**
```bash
git add apps/pos/src/cashier/promoValidate.ts apps/pos/src/cashier/promoValidate.test.ts apps/pos/src/cashier/CashierScreen.tsx
git commit -m "feat(code-sp3): POS validator requires-customer parity + hasCustomer ctx"
```

---

## Task 5: Write + read repo wiring (gap-class)

**Files:** Modify `backend/internal/write/repo.go` (code write struct + single INSERT :748 + UPDATE :873 + batch INSERT in `CreateDiscountCodeBatch`), `backend/internal/read/repo.go` (`DiscountCodes` :850 + `DiscountCodesByIDs` :865).

**Interfaces:** Consumes the regenerated `perCustomerLimit` field on the code write input. Produces `per_customer_limit` persisted on create/update/batch and returned in both read json shapes.

- [ ] **Step 1: Write struct + single INSERT/UPDATE** in `write/repo.go`:
  - The discount-code write struct (near line 741, has `Combinable bool`): add `PerCustomerLimit *int` mapped from the API field (mirror how `UsageLimit *int` is carried).
  - Single INSERT (line 748): add `per_customer_limit` to the column list + a `$N` bind + the value.
  - UPDATE (line 873): add `per_customer_limit=$N` + the value.

- [ ] **Step 2: Batch INSERT** — in `CreateDiscountCodeBatch` (SP-Code-1; grep `INSERT INTO discount_codes` in write/repo.go for the batch site with `ON CONFLICT (code) DO NOTHING`): add `per_customer_limit` to the column list + bind, sourced from the batch settings (the whole batch shares one `perCustomerLimit`).

- [ ] **Step 3: Read json** — in `read/repo.go`, add `'perCustomerLimit',per_customer_limit,` to the `json_build_object` in BOTH `DiscountCodes` (line ~850) and `DiscountCodesByIDs` (line ~865), next to `'usageLimit',usage_limit,`.

- [ ] **Step 4: Build + gen-check + a round-trip grep**
```bash
cd backend && go build ./... && go vet ./internal/write/ ./internal/read/ && make gen-check
grep -c per_customer_limit backend/internal/write/repo.go   # expect >= 3 (struct-less; INSERT + UPDATE + batch)
grep -c perCustomerLimit backend/internal/read/repo.go       # expect 2 (both read shapes)
```
Expected: build clean; the greps confirm every write + read path carries the column.

- [ ] **Step 5: Commit**
```bash
git add backend/internal/write/repo.go backend/internal/read/repo.go
git commit -m "feat(code-sp3): persist + return per_customer_limit (single/update/batch write + both read json)"
```

---

## Task 6: Backoffice authoring

**Files:** Modify the code form in `apps/backoffice/src/screens/promotions/` (grep `usageLimit`/`Batas Pakai` for the single-code modal) + `DiscountCodeBatchModal.tsx`.

**Interfaces:** Consumes the `perCustomerLimit` API field. Adds a "Batas per pelanggan" number input to the single-code form (with edit-populate round-trip) and the batch modal.

- [ ] **Step 1: Single-code form** — near the existing "Batas Pakai" (`usageLimit`) input, add:
```tsx
<label className="block">
  <span className="...">Batas per pelanggan</span>
  <input type="number" min={1} value={perCustomerLimit ?? ''} onChange={e => setPerCustomerLimit(e.target.value === '' ? undefined : Number(e.target.value))} className="..." />
  <span className="text-xs text-gray-500">kosong = tak terbatas</span>
</label>
```
Wire `perCustomerLimit` into the form state, the save payload (empty → `undefined` so it clears to null per [[openapi-nullable-ref-codegen-gotcha]]), AND **edit-populate**: wherever the form seeds from an existing code (the `openEdit`/`editCode` handler), set `perCustomerLimit` from the loaded code — the SP-Promo-4 lesson (a new field omitted from the edit-populate path silently wipes on save). Match the surrounding input styling (copy the `usageLimit` input's classes).

- [ ] **Step 2: Batch modal** — in `DiscountCodeBatchModal.tsx`, add the same "Batas per pelanggan" input to the shared batch settings; include `perCustomerLimit` in the batch create payload (empty → omit).

- [ ] **Step 3: Verify**
```bash
cd apps/backoffice && corepack pnpm tsc --noEmit && corepack pnpm vite build
```
Expected: clean.

- [ ] **Step 4: Commit**
```bash
git add apps/backoffice/src/screens/promotions/
git commit -m "feat(code-sp3): backoffice per-customer cap field (single form + batch modal)"
```

---

## Task 7: Verify — live e2e, deploy, APK, handoff

**Files:** Create throwaway `backend/cmd/codepercust/main.go` (never commit).

- [ ] **Step 1: Local gate**
```bash
cd backend && go build ./... && go test ./... && make gen-check
cd ../apps/pos && corepack pnpm tsc --noEmit && corepack pnpm vitest run && corepack pnpm vite build
cd ../backoffice && corepack pnpm tsc --noEmit && corepack pnpm vite build
```
All green.

- [ ] **Step 2: Throwaway e2e** (`cmd/codepercust`, real `OrderService` + real migrations 0001→0042, zero-residue, deleted). Connect via `config.Load()`→`db.Connect`. Seed (prefix `E2EPC`): reuse an outlet; 2 customers A/B (`INSERT INTO customers`); a code `E2EPC1` with `per_customer_limit=1`, `is_active=true`. Drive real `CreateOrder` (mirror an existing service e2e's order input builder — grep a prior `cmd/promo*` in git history for the `CreateOrderInput` shape; construct minimal 1-line orders with `CustomerID` set + `DiscountCodes: []string{"E2EPC1"}`). Assert:
  1. **A 1st redemption (online)** → order completes; `applied_discount_codes` contains `E2EPC1`.
  2. **A 2nd redemption (online)** → `ErrDiscountRejected` with `ViolationPerCustomerCapReached`.
  3. **A 2nd redemption (offline=true)** → order kept + `discount_warning=true` (no error).
  4. **B 1st redemption (online)** → OK (per-customer, not global).
  5. **Refund A's 1st completed order** → A can redeem again online (self-heal: count drops).
  6. **Anonymous order (no CustomerID) with `E2EPC1` online** → `ErrDiscountRejected` with `ViolationRequiresCustomer`.
  7. **Control:** a separate code with `usage_limit=1, per_customer_limit=NULL` → 2nd redemption by ANY customer hits the global `ViolationUsageLimit` (unchanged).
Cleanup (defer): delete orders/grants/customers/codes with prefix `E2EPC`; self-check zero residue; `rm -rf backend/cmd/codepercust`. Run against Neon per [[neon-e2e-verification]] (authorized).

- [ ] **Step 3: Push + deploy (migration 0042)**
```bash
git push origin prod-hardening
gcloud run deploy mandalika-pos --source backend --region asia-southeast2 --quiet
```
Migration auto-applies on boot; confirm `/readyz` 200.

- [ ] **Step 4: Authed smoke** (per [[neon-e2e-verification]]): create a capped code via `POST /discount-codes` with `perCustomerLimit:1` → GET the code list → confirm `perCustomerLimit` round-trips; delete it. (Full redemption flow is covered by the Step-2 e2e.)

- [ ] **Step 5: APK** (POS validator changed): after the push is green,
```bash
gh workflow run android-release.yml --ref prod-hardening -f api_url=https://mandalika-pos-538849926142.asia-southeast2.run.app
```
Record the run id (builds from origin — [[apk-builds-from-origin-gotcha]]).

- [ ] **Step 6: Handoff + memory** — update `discount-code-enhancements` memory + `MEMORY.md` + `SESSION_HANDOFF.md` (SP-Code-3 done; next = SP-Code-4 customer-assigned). Commit + push.

---

## Notes for the implementer
- **Task 3 is the crux** (the count query + hybrid + merge-keeper + race-safety). No unit harness → the Task-7 e2e (with a refund + an offline case + an anonymous case + a global-limit control) is its proof. Opus review.
- Race-safety comes for free from the existing `FOR UPDATE` on the code row (held SELECT→`usage_count++`); do NOT add a second lock.
- Task 5 is the gap-class task — the SP-Promo-3a bug was exactly "column added to OpenAPI+form but not the write SQL." The Step-4 greps are the guard.
- The requires-customer check exists in BOTH validators (Go authoritative + TS local UX); the count exists ONLY server-side (the POS can't know history offline).
