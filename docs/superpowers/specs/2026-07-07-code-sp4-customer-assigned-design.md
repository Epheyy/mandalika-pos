# SP-Code-4 — Customer-Assigned Discount Codes (Design)

**Date:** 2026-07-07
**Branch:** `prod-hardening`
**Status:** Design approved — build
**Slice:** fourth and LAST of the discount-code series (SP-Code-1 bulk-gen + SP-Code-2 analytics + SP-Code-3 per-customer-cap done). Assigns a code to ONE specific customer; reuses SP-Code-3's server-authoritative + hybrid + shared-validator gating.

---

## Context
Discount codes are redeemable by anyone (subject to `usage_limit`, `min_purchase`, dates, and — since SP-Code-3 — an optional `per_customer_limit` + requires-a-customer). SP-Code-4 adds `discount_codes.customer_id`: when set, ONLY that customer may redeem the code (a personal voucher). This reuses SP-Code-3's machinery: the redemption path `OrderService.resolvePromos` (order.go:805) loads each code row `FOR UPDATE`, runs the shared validator `ValidateCode` (Go) whose 1:1 TS port is `validateCode` (`apps/pos/src/cashier/promoValidate.ts`), and both receive a `PromoEvalContext` that (since SP-Code-3) carries `HasCustomer` + `CustomerID` (Go) / `hasCustomer` (TS). The POS already looks up the cart customer; the backoffice already has a customer typeahead endpoint `lookupCustomers(q)` → `GET /sync/customers/lookup`.

## Decisions (locked during brainstorm)
1. **The rule lives in the SHARED validator** (`ValidateCode`/`validateCode`), NOT a server-only DB query (unlike SP-Code-3's count) — the POS knows the cart customer, so it can enforce locally and the server backstops via the existing hybrid. When `customer_id != null`, require `hasCustomer && cartCustomerId == customer_id`, else → new `ViolationWrongCustomer`. One rule covers both the no-customer and wrong-customer cases.
2. **Local guard + server backstop.** POS greys the code with a reason; server rejects authoritatively (online 422 / offline record+flag).
3. **Match by RAW customer_id** on both POS and server (no merge-keeper resolution), so both sides behave identically. **Documented limitation:** if the assigned customer is later merged (SP-CRM-Merge), the code stops matching and must be reissued. Rare; avoids touching the merge transaction.
4. **Single-code form only** — the batch generator does NOT get customer assignment (assigning N codes to one customer is nonsensical; "one unique code per customer" is a separate feature, out of scope).
5. **`ON DELETE CASCADE`** on the FK — a personal code dies with its customer (vs `SET NULL`, which would wrongly make it public).
6. **Independent of the other code fields** — a code may combine `customer_id` with `per_customer_limit`, `usage_limit`, `promotion_id`, etc.; all checks compose.
7. Full slice: **migration 0043 + APK** (POS validator changed).

---

## 1. Schema — migration `0043_discount_code_customer_id.sql`
```sql
ALTER TABLE discount_codes ADD COLUMN customer_id uuid REFERENCES customers(id) ON DELETE CASCADE;
```
`NULL` = unassigned (default; all existing codes unchanged). No backfill, no index (a code is loaded by `code`, already unique-indexed; the match is an in-memory string compare, not a query).

## 2. OpenAPI + codegen
- `DiscountCode`: add `customerId` (`type: string, nullable: true`) AND a read-only denormalized `customerName` (`type: string, nullable: true`) so the backoffice list + edit form show "Khusus: <name>" without a second fetch.
- The discount-code create/update INPUT schema: add `customerId` (nullable string). NOT the batch input.
- Regenerate `api.gen.go` + `schema.d.ts` (`make gen-check`). Go: `nullable.Nullable[...]`; TS: `string | null`. Per [[openapi-nullable-ref-codegen-gotcha]], clearing from TS uses `undefined`/omit.

## 3. Engine — the shared validator rule
- `CodeRow` gains `CustomerID *string`.
- The `discount_codes` SELECT in `resolvePromos` (order.go:869) adds `customer_id`, scanned LAST into `&row.CustomerID` (append after `per_customer_limit`).
- New const `ViolationWrongCustomer PromoViolation = "wrong_customer"`.
- `ValidateCode(c CodeRow, ec PromoEvalContext)` — add, before `return v`:
  ```
  if c.CustomerID != nil && (!ec.HasCustomer || *c.CustomerID != ec.CustomerID) → append ViolationWrongCustomer
  ```
- Handler message map (`handlers/writes.go` switch) + `promo_message_test.go`: `ViolationWrongCustomer` → **"Kode ini khusus untuk pelanggan tertentu"**.
- No change to the per-customer COUNT block (SP-Code-3) — this rule is validator-only and composes with it.

## 4. POS — TS parity
- `customerId` rides on the synced `DiscountCode` (OpenAPI schema).
- TS `PromoEvalContext` gains `customerId?: string` (SP-Code-3 added only `hasCustomer`). Thread it from `state.selectedCustomer?.id` at BOTH the apply-code ctx and the checkout re-guard ctx (the two `PromoEvalContext` construction sites SP-Code-3 touched in `CashierScreen.tsx`; also the `PromoPanel`/`AdjustmentDrawer` prop chain if they build ctx).
- `validateCode` — add: `if (c.customerId != null && c.customerId !== ctx.customerId) v.push('wrong_customer')` (a null cart `customerId` also fails the `!==`, covering the no-customer case).
- `Violation` union gains `'wrong_customer'`; `MESSAGES` (exhaustive Record) gains `wrong_customer: 'Kode ini khusus untuk pelanggan tertentu'`.

## 5. Backoffice — customer typeahead on the single-code form
- `DiscountCodeFormModal.tsx`: add a **customer search field** (a typeahead, NOT a `<Select>` — customers scale to 50k–500k). Debounced input → `api.lookupCustomers(q)` (→ `GET /sync/customers/lookup`, returns `Customer[]`) → dropdown of matches (name · phone) → pick sets `customerId` + shows the chosen name with a clear (×) button → cleared = unassigned. When editing an already-assigned code, seed the display from the code's `customerName` (from the read json) so no fetch is needed.
- `Promotions.tsx` (parent owns form state): add `customerId` to `EMPTY_CODE`, `openEditCode` (edit-populate), and `toggleCode` (the SP-Promo-4 wipe lesson — omitting it silently un-assigns on toggle). Empty/cleared → `undefined` in the payload (clears to null).
- The code LIST row can show a small "Khusus: <customerName>" badge when assigned (nice-to-have, low effort via the denormalized field).

## 6. Read repo
- `DiscountCodes()` + `DiscountCodesByIDs()` json_build_object: add `'customerId', dc.customer_id` and `'customerName', cust.name` via `LEFT JOIN customers cust ON cust.id = dc.customer_id`. (Alias `discount_codes dc` if not already aliased.)

## 7. Write repo
- The code write struct gains `CustomerID *string \`json:"customerId"\``.
- `CreateDiscountCode` INSERT + `UpdateDiscountCode` UPDATE: add `customer_id` column + bind (`nullUUID(d.CustomerID)` — mirror how `promotion_id` handles a nullable uuid; renumber `$N`, WHERE id stays last). NOT the batch INSERT.

## 8. Testing & verification
- **Go unit** (`ValidateCode`, table): assigned + matching customer → no violation; assigned + wrong customer → `ViolationWrongCustomer`; assigned + no customer → `ViolationWrongCustomer`; unassigned (nil) → never.
- **TS unit** (`validateCode`, vitest): the mirror cases.
- **Live e2e** (throwaway `cmd/codeassigned`, real `OrderService` + migrations 0001→0043, deleted, zero-residue — inject `DATABASE_URL` secret + deploy-first per [[neon-e2e-verification]]; loyalty is ENABLED so use a real `users.id` cashier + a real FK product/stock row with snapshot-restore): seed customers A/B + a code assigned to A. Assert: A redeems → OK; B redeems the same code → 422 `ViolationWrongCustomer`; anonymous → 422 `ViolationWrongCustomer`; A offline mismatch (B, offline) → kept + `discount_warning`; an UNASSIGNED code → anyone redeems OK (unchanged).
- **Gap-class:** `make gen-check` clean; the field appears in read json (×2, with the join) AND write INSERT/UPDATE AND OpenAPI AND the form (create/edit/toggle) — trace all (SP-Promo-3a lesson).
- **Local gate:** go build+vet+test+gen-check; POS tsc+vite+vitest; backoffice tsc+vite.
- **Deploy:** migration 0043 (`gcloud run deploy`), `/readyz` 200; **authed smoke** — POST a code with `customerId` → GET list → `customerId` + `customerName` round-trip; delete. **New APK** (POS validator changed).

## 9. Model routing & rollout
Sonnet implements; **Opus** reviews the validator rule + engine SELECT/scan + type-gen + the read-join/write repo (gap-class); Sonnet the POS parity + backoffice typeahead. Final whole-slice Opus review. Deploy backend (mig 0043) + Cloudflare backoffice + APK.

## Out of scope / deferred
- Batch customer assignment; "one unique code per customer" bulk generation.
- Merge-following (documented limitation — reissue the code if the assigned customer is merged).
- Showing the customer their assigned codes (a CRM/customer-detail view, separate).
- This is the LAST discount-code slice; next queued big item is the OTA slice ([[ota-capgo-self-hosted]]).
