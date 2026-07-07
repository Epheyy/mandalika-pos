# SP-Code-4 Customer-Assigned Discount Codes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Assign a discount code to ONE customer (`discount_codes.customer_id`); only that customer may redeem it, enforced by a shared-validator rule (POS greys + server backstop).

**Architecture:** A nullable `customer_id` on `discount_codes` (mig 0043, `ON DELETE CASCADE`). One rule in the shared validator `ValidateCode` (Go) + `validateCode` (TS): when `customer_id != null`, require the cart's customer to match by RAW id, else `ViolationWrongCustomer` — riding the existing online-reject/offline-flag hybrid. A denormalized `customerName` in the code read json drives a backoffice customer typeahead. Reuses SP-Code-3's `PromoEvalContext.CustomerID`/`HasCustomer` plumbing.

**Tech Stack:** Go (pgx, `internal/service`), TypeScript (POS pure validator + React backoffice), oapi-codegen + openapi-typescript.

**Spec:** `docs/superpowers/specs/2026-07-07-code-sp4-customer-assigned-design.md`

## Global Constraints
- **The rule is validator-only** (no server-only DB query): in `ValidateCode`/`validateCode`, `customer_id != null && (!hasCustomer || cartCustomerId != customer_id)` → `ViolationWrongCustomer`. One rule covers no-customer AND wrong-customer.
- **Match by RAW id** on both POS and server (no merge-keeper resolution) — identical behavior both sides. Documented limitation: an assigned customer who is later merged must be reissued a code (do NOT add merge-following).
- **Message (verbatim):** `ViolationWrongCustomer` → **"Kode ini khusus untuk pelanggan tertentu"** (Go handler map + TS `MESSAGES`).
- **FK `ON DELETE CASCADE`** — a personal code is deleted with its customer.
- **Single-code form only** — NOT the batch generator/input.
- **Gap-class rule:** adding a column = trace read json (×2, here via a correlated subquery for `customerName`) AND write INSERT + UPDATE AND OpenAPI AND the form (create/edit/toggle) (SP-Promo-3a + SP-Promo-4 lessons).
- Migration **0043**. POS validator changed → **APK**. Don't touch pre-existing unrelated working-tree files.
- Model routing: engine/validator + type-gen + repo (gap-class) → **Opus**; POS parity + backoffice typeahead → Sonnet.

## File Structure
- `backend/internal/db/migrations/0043_discount_code_customer_id.sql` — CREATE.
- `backend/api/openapi.yaml` + regen — `customerId` on `DiscountCode` + code input; read-only `customerName` on `DiscountCode`.
- `backend/internal/service/promo_validate.go` — `CodeRow.CustomerID`, `ViolationWrongCustomer`, `ValidateCode` rule.
- `backend/internal/service/order.go` — SELECT `customer_id` + scan (`resolvePromos`).
- `backend/internal/handlers/writes.go` (+ `promo_message_test.go`) — message case.
- `apps/pos/src/cashier/promoValidate.ts` (+ `promoValidate.test.ts`), `CashierScreen.tsx` — TS parity + ctx `customerId`.
- `backend/internal/write/repo.go` — code write struct + INSERT + UPDATE.
- `backend/internal/read/repo.go` — `DiscountCodes` + `DiscountCodesByIDs` json (customerId + customerName subquery).
- `apps/backoffice/src/screens/promotions/DiscountCodeFormModal.tsx` + `apps/backoffice/src/screens/Promotions.tsx` — customer typeahead + form-state paths.
- `backend/cmd/codeassigned/main.go` — throwaway (Task 6).

---

## Task 1: Migration 0043 + OpenAPI + regen

**Files:** Create migration; modify `backend/api/openapi.yaml`; regen `api.gen.go`, `schema.d.ts`.

**Interfaces:** Produces DB column `discount_codes.customer_id uuid`; API `customerId` (nullable) on `DiscountCode` + code input, `customerName` (nullable, read-only) on `DiscountCode`.

- [ ] **Step 1: Migration** — `backend/internal/db/migrations/0043_discount_code_customer_id.sql`:
```sql
ALTER TABLE discount_codes ADD COLUMN customer_id uuid REFERENCES customers(id) ON DELETE CASCADE;
```

- [ ] **Step 2: OpenAPI** — on the `DiscountCode` schema add BOTH:
```yaml
        customerId:
          type: string
          nullable: true
        customerName:
          type: string
          nullable: true
```
On the discount-code create/update INPUT schema add ONLY `customerId` (the same 3-line nullable block). Do NOT touch the batch input schema. Match the sibling `perCustomerLimit` placement.

- [ ] **Step 3: Regen + verify**
```bash
cd backend && make gen-go && cd ..
corepack pnpm@10.11.1 --filter @mandalika/api gen
cd backend && make gen-check && go build ./...
```
Expected: gen-check clean post-commit; `grep -n "CustomerId\|CustomerName" backend/internal/api/api.gen.go` shows them on `DiscountCode` (`nullable.Nullable[...]`) + `CustomerId` on the input struct; `grep -n "customerId\|customerName" packages/api/src/schema.d.ts` shows `string | null`.

- [ ] **Step 4: Commit**
```bash
git add backend/internal/db/migrations/0043_discount_code_customer_id.sql backend/api/openapi.yaml backend/internal/api/api.gen.go packages/api/src/schema.d.ts
git commit -m "feat(code-sp4): migration 0043 customer_id + OpenAPI customerId/customerName, regen"
```

---

## Task 2: Shared validator — wrong-customer rule (Go)

**Files:** Modify `promo_validate.go`, `order.go`, `handlers/writes.go`, `handlers/promo_message_test.go`, `promo_validate_test.go`.

**Interfaces:**
- Produces: `CodeRow.CustomerID *string`; const `ViolationWrongCustomer PromoViolation = "wrong_customer"`; `ValidateCode` appends it when `c.CustomerID != nil && (!ec.HasCustomer || *c.CustomerID != ec.CustomerID)`.
- Consumes: `PromoEvalContext.HasCustomer`+`CustomerID` (added in SP-Code-3).

- [ ] **Step 1: Failing unit test** — add to the `ValidateCode` table in `promo_validate_test.go` (near the SP-Code-3 requires-customer cases). Use a `baseWithCustomer` ctx whose `HasCustomer=true, CustomerID="cust-1"` (mirror how the SP-Code-3 cases set it):
```go
{"assigned + matching customer ok", CodeRow{CustomerID: sptr("cust-1")}, baseWithCustomer, nil},
{"assigned + wrong customer", CodeRow{CustomerID: sptr("cust-2")}, baseWithCustomer, []PromoViolation{ViolationWrongCustomer}},
{"assigned + no customer", CodeRow{CustomerID: sptr("cust-1")}, base, []PromoViolation{ViolationWrongCustomer}},
{"unassigned ok", CodeRow{}, base, nil},
```
Add a `sptr := func(s string) *string { return &s }` helper in the test if none exists (grep for an existing `*string` helper first; there is `iptr`/`fptr`/`dptr`).

- [ ] **Step 2: Run — fails to compile** (`CustomerID`/`ViolationWrongCustomer` undefined):
```bash
cd backend && go test ./internal/service/ -run TestValidateCode 2>&1 | head
```

- [ ] **Step 3: Implement** in `promo_validate.go`:
  - Const (near `ViolationRequiresCustomer`): `ViolationWrongCustomer PromoViolation = "wrong_customer"`.
  - `CodeRow` struct: add `CustomerID *string` (after `PerCustomerLimit`).
  - `ValidateCode` — before `return v`, add:
```go
	if c.CustomerID != nil && (!ec.HasCustomer || *c.CustomerID != ec.CustomerID) {
		v = append(v, ViolationWrongCustomer)
	}
```

- [ ] **Step 4: SELECT + scan in order.go** — the code SELECT (order.go:869) currently ends `..., per_customer_limit FROM discount_codes ... FOR UPDATE` with `Scan(..., &row.PerCustomerLimit)`. Add `customer_id` as the LAST column and `&row.CustomerID` as the LAST scan arg:
```go
		`SELECT id, promotion_id, type, value, start_date, end_date, min_purchase, usage_limit, usage_count, combinable, per_customer_limit, customer_id
		   FROM discount_codes WHERE code=$1 AND is_active=true FOR UPDATE`, code).
		Scan(&id, &promotionID, &kind, &value, &row.StartDate, &row.EndDate, &row.MinPurchase, &row.UsageLimit, &row.UsageCount, &row.Combinable, &row.PerCustomerLimit, &row.CustomerID)
```

- [ ] **Step 5: Message map** — `handlers/writes.go` violation switch: `case service.ViolationWrongCustomer: return "Kode ini khusus untuk pelanggan tertentu"`. Add the matching row to `promo_message_test.go`:
```go
		{"wrong customer", []service.PromoViolation{service.ViolationWrongCustomer}, "Kode ini khusus untuk pelanggan tertentu"},
```

- [ ] **Step 6: Run tests + build**
```bash
cd backend && go test ./internal/service/ ./internal/handlers/ && go build ./...
```
Expected: PASS.

- [ ] **Step 7: Commit**
```bash
git add backend/internal/service/promo_validate.go backend/internal/service/promo_validate_test.go backend/internal/service/order.go backend/internal/handlers/writes.go backend/internal/handlers/promo_message_test.go
git commit -m "feat(code-sp4): wrong-customer rule in shared validator + message"
```

---

## Task 3: POS validator parity (TS)

**Files:** Modify `apps/pos/src/cashier/promoValidate.ts` (+ `promoValidate.test.ts`), `apps/pos/src/cashier/CashierScreen.tsx`.

**Interfaces:** `PromoEvalContext` (TS) gains `customerId?: string`; `Violation` union gains `'wrong_customer'`; `validateCode` appends it when `c.customerId != null && c.customerId !== ctx.customerId`; `MESSAGES.wrong_customer = 'Kode ini khusus untuk pelanggan tertentu'`.

- [ ] **Step 1: Failing vitest** — add to `promoValidate.test.ts` `validateCode` cases (the shared ctx already has `hasCustomer` from SP-Code-3; add `customerId` to it or per-case):
```ts
{ name: 'assigned + matching customer ok', row: { customerId: 'cust-1' }, ctx: { ...base, hasCustomer: true, customerId: 'cust-1' }, want: [] },
{ name: 'assigned + wrong customer', row: { customerId: 'cust-2' }, ctx: { ...base, hasCustomer: true, customerId: 'cust-1' }, want: ['wrong_customer'] },
{ name: 'assigned + no customer', row: { customerId: 'cust-1' }, want: ['wrong_customer'] },
```
(Match the test table's actual shape — some cases pass a per-case `ctx`, others use the shared `base`. Follow the existing pattern in that file.)

- [ ] **Step 2: Run — fails**
```bash
cd apps/pos && corepack pnpm vitest run src/cashier/promoValidate.test.ts 2>&1 | tail
```

- [ ] **Step 3: Implement** in `promoValidate.ts`:
  - `Violation` union: add `| 'wrong_customer'`.
  - `PromoEvalContext` interface: add `customerId?: string`.
  - `validateCode` (after the SP-Code-3 requires-customer / usage checks, before `return v`): `if (c.customerId != null && c.customerId !== ctx.customerId) v.push('wrong_customer')`.
  - `MESSAGES` (exhaustive Record): add `wrong_customer: 'Kode ini khusus untuk pelanggan tertentu',`.

- [ ] **Step 4: Thread `customerId` into the ctx** — in `CashierScreen.tsx`, at the two `PromoEvalContext` construction sites SP-Code-3 touched (the apply-code ctx ~L678 and the checkout re-guard `guardCtx` ~L703, both already set `hasCustomer: state.selectedCustomer !== null`), add `customerId: state.selectedCustomer?.id`. If `PromoPanel`/`AdjustmentDrawer` build their own ctx from props, thread `customerId` there too (tsc will name any site missing it).

- [ ] **Step 5: Run vitest + tsc + build**
```bash
cd apps/pos && corepack pnpm vitest run src/cashier/promoValidate.test.ts && corepack pnpm tsc --noEmit && corepack pnpm vite build
```
Expected: PASS + clean.

- [ ] **Step 6: Commit**
```bash
git add apps/pos/src/cashier/promoValidate.ts apps/pos/src/cashier/promoValidate.test.ts apps/pos/src/cashier/CashierScreen.tsx
git commit -m "feat(code-sp4): POS validator wrong-customer parity + customerId ctx"
```

---

## Task 4: Repo wiring — write + read (gap-class)

**Files:** Modify `backend/internal/write/repo.go` (code write struct + INSERT + UPDATE), `backend/internal/read/repo.go` (`DiscountCodes` + `DiscountCodesByIDs` json).

**Interfaces:** Consumes the regenerated `customerId`. Produces `customer_id` persisted (create/update) + `customerId`/`customerName` returned in both read shapes.

- [ ] **Step 1: Write struct + INSERT + UPDATE** in `write/repo.go`:
  - The code write struct (has `PerCustomerLimit *int json:"perCustomerLimit"`): add `CustomerID string \`json:"customerId"\`` (a plain string like the sibling `PromotionID`; empty = unassigned).
  - `CreateDiscountCode` INSERT (columns end `..., per_customer_limit` VALUES `$1..$11`): add `customer_id` as `$12` and `nullUUID(d.CustomerID)` to the args (after `d.PerCustomerLimit`). `nullUUID("")` → SQL NULL, exactly like `nullUUID(d.PromotionID)`.
  - `UpdateDiscountCode` UPDATE (`..., per_customer_limit=$11 WHERE id=$12`): change to `..., per_customer_limit=$11, customer_id=$12 WHERE id=$13`; add `nullUUID(d.CustomerID)` before the `id` arg. **Walk the `$N`: 12 SET binds + `id`=$13.**

- [ ] **Step 2: Read json ×2** — in `read/repo.go`, add to the `json_build_object` in BOTH `DiscountCodes` and `DiscountCodesByIDs` (next to `'perCustomerLimit',per_customer_limit,`):
```
'customerId',customer_id,'customerName',(SELECT name FROM customers WHERE id=discount_codes.customer_id),
```
(A correlated subquery — `discount_codes` is the un-aliased outer table; returns NULL when `customer_id` is NULL. Avoids re-aliasing every existing column with a JOIN.)

- [ ] **Step 3: Build + gen-check + round-trip greps**
```bash
cd backend && go build ./... && go vet ./internal/write/ ./internal/read/ && go test ./... && make gen-check
grep -c customer_id backend/internal/write/repo.go   # expect >= 2 (INSERT + UPDATE)
grep -c customerName backend/internal/read/repo.go    # expect 2 (both read shapes)
```
Expected: clean; greps meet counts.

- [ ] **Step 4: Commit**
```bash
git add backend/internal/write/repo.go backend/internal/read/repo.go
git commit -m "feat(code-sp4): persist customer_id (create/update) + return customerId/customerName (both read json)"
```

---

## Task 5: Backoffice — customer typeahead on the code form

**Files:** Modify `apps/backoffice/src/screens/promotions/DiscountCodeFormModal.tsx`, `apps/backoffice/src/screens/Promotions.tsx`.

**Interfaces:** Consumes `api.lookupCustomers(q)` → `Customer[]` (`{id,name,phone}`), the `customerId`/`customerName` fields. Adds a searchable customer picker; wires `customerId` through all code-form state paths.

- [ ] **Step 1: Form-state paths in `Promotions.tsx`** (the SP-Promo-4 wipe lesson — trace ALL):
  - `EMPTY_CODE` default: add `customerId: undefined`.
  - `openEditCode` (edit-populate): add `customerId: c.customerId ?? undefined`.
  - `toggleCode` (active/inactive rebuild): add `customerId: c.customerId ?? undefined`.
  - Save spread already carries it (`...codeForm`); empty/cleared → `undefined` → clears to null.
  - Pass the currently-assigned name into the modal for display: when opening edit, the form also needs the name — pass `c.customerName` (from the read json) so the modal shows it without a fetch. Add a `customerName` to the code form state too (seed `undefined` in `EMPTY_CODE`, `c.customerName ?? undefined` in `openEditCode`/`toggleCode`). `customerName` is display-only; it need NOT be in the save payload (the server ignores it / it's read-only).

- [ ] **Step 2: Customer typeahead in `DiscountCodeFormModal.tsx`** — add a search field near the `promotionId` Select. Mirror the debounced-lookup pattern used in `apps/backoffice/src/screens/Customers.tsx` (which searches customers). Sketch:
```tsx
const [custQuery, setCustQuery] = useState('')
const [custResults, setCustResults] = useState<Customer[]>([])
// debounced lookup
useEffect(() => {
  if (!custQuery.trim()) { setCustResults([]); return }
  const t = setTimeout(async () => {
    try { setCustResults(await api.lookupCustomers(custQuery, 10)) } catch { setCustResults([]) }
  }, 250)
  return () => clearTimeout(t)
}, [custQuery])
```
UI: a `Field` labeled **"Khusus pelanggan (opsional)"**. When `form.customerId` is set, show the chosen name (`form.customerName ?? form.customerId`) with a **× clear** button (`setForm(f => ({...f, customerId: undefined, customerName: undefined}))`). When unset, show the text input bound to `custQuery` + a results dropdown; picking one → `setForm(f => ({...f, customerId: c.id, customerName: c.name}))` and clear `custQuery`/`custResults`. Import `Customer` from `@mandalika/api` and `api` from the app's api module. Helper text "kosong = bisa dipakai siapa saja".

- [ ] **Step 3: List badge (low-effort)** — in `Promotions.tsx`, the code list row: when `c.customerId`, render a small "Khusus: {c.customerName ?? '—'}" badge (mirror the existing status/kuota cells' styling). Optional but cheap; include it.

- [ ] **Step 4: Verify**
```bash
cd apps/backoffice && corepack pnpm tsc --noEmit && corepack pnpm vite build
```
Expected: clean.

- [ ] **Step 5: Commit**
```bash
git add apps/backoffice/src/screens/promotions/DiscountCodeFormModal.tsx apps/backoffice/src/screens/Promotions.tsx
git commit -m "feat(code-sp4): backoffice customer typeahead on the code form"
```

---

## Task 6: Verify — live e2e, deploy, APK, handoff

**Files:** Create throwaway `backend/cmd/codeassigned/main.go` (never commit).

- [ ] **Step 1: Local gate**
```bash
cd backend && go build ./... && go test ./... && make gen-check
cd ../apps/pos && corepack pnpm tsc --noEmit && corepack pnpm vitest run && corepack pnpm vite build
cd ../backoffice && corepack pnpm tsc --noEmit && corepack pnpm vite build
```
All green.

- [ ] **Step 2: Push + deploy FIRST (migration 0043)** — per [[neon-e2e-verification]], a migration slice must deploy before the injected e2e (the migration applies on boot; otherwise Neon lacks the column):
```bash
git push origin prod-hardening
gcloud run deploy mandalika-pos --source backend --region asia-southeast2 --quiet
```
Confirm `/readyz` 200.

- [ ] **Step 3: Throwaway e2e** (`cmd/codeassigned`, real `OrderService`, zero-residue, deleted). **Inject the Neon secret** and mirror the SP-Code-3 e2e scaffolding (which is the proven template — reconstruct it): `DATABASE_URL="$(gcloud secrets versions access latest --secret=DATABASE_URL --project=mandalika-pos)" go run ./cmd/codeassigned`. Setup: fetch a real outlet+product+variant from one `outlet_variant_stock` row (snapshot `stock`, restore in cleanup); fetch a real `users.id` for `CashierID` (loyalty is enabled → `point_transactions.created_by` FK); seed customers A/B (prefix `E2ECA`); seed a code `E2ECA1` assigned to A (`INSERT INTO discount_codes (code,type,value,is_active,customer_id) VALUES ('E2ECA1','fixed',5000,true,<A>)`); seed an UNASSIGNED control `E2ECA2`. Drive `CreateOrder` (fake-free items = the real variant; `DiscountCodes:["E2ECA1"]`). Assert:
  1. **A redeems E2ECA1 (online)** → OK.
  2. **B redeems E2ECA1 (online)** → `ErrDiscountRejected` with `ViolationWrongCustomer`.
  3. **Anonymous (no CustomerID) redeems E2ECA1 (online)** → `ViolationWrongCustomer`.
  4. **B redeems E2ECA1 (OFFLINE)** → kept + `discount_warning` (lenient).
  5. **Anyone redeems the UNASSIGNED E2ECA2 (online)** → OK (unchanged).
Detect violations via `errors.As(err, &*service.ErrDiscountRejected)` + scan `.Violations`. Cleanup (defer): delete orders (`order_number LIKE 'E2ECA-%'`) / codes (`E2ECA1`,`E2ECA2`) / customers (`phone LIKE 'E2ECA%'`; `point_transactions` cascade on customer delete) + restore stock; zero-residue self-check; `rm -rf backend/cmd/codeassigned`.

- [ ] **Step 4: Authed smoke** (per [[neon-e2e-verification]]): login admin → create a customer (or reuse one via `lookupCustomers`) → `POST /discount-codes` with `customerId:<id>` → GET the code list → confirm `customerId` + `customerName` round-trip → delete the code.

- [ ] **Step 5: APK** (POS validator changed): after the push is green,
```bash
gh workflow run android-release.yml --ref prod-hardening -f api_url=https://mandalika-pos-538849926142.asia-southeast2.run.app
```
Record the run id ([[apk-builds-from-origin-gotcha]]).

- [ ] **Step 6: Handoff + memory** — update `discount-code-enhancements` (SP-Code-4 done → series COMPLETE) + `MEMORY.md` + `SESSION_HANDOFF.md` (next = OTA slice [[ota-capgo-self-hosted]]). Commit + push.

---

## Notes for the implementer
- **Task 2 is the correctness core** (the validator rule + SELECT/scan alignment). Unit-tested; the Task-6 e2e proves the end-to-end reject/allow.
- The rule is validator-only — it composes with SP-Code-3's requires-customer + count and every other code check; do NOT add a server-only query.
- Match by RAW id both sides (POS + server) — do NOT resolve the merge keeper (documented limitation).
- Task 4 gap-class: the SP-Promo-3a bug was a column added to OpenAPI+form but not the write SQL. The Step-3 greps guard it. The read side uses a correlated subquery for `customerName` (no JOIN/alias churn).
- Task 6: deploy BEFORE the e2e (mig 0043) and INJECT the Neon `DATABASE_URL` — the local `.env` points at a local Postgres without the new migration ([[neon-e2e-verification]]).
