# SP-Code-3 — Per-Customer Discount-Code Redemption Cap (Design)

**Date:** 2026-07-07
**Branch:** `prod-hardening`
**Status:** Design approved — build
**Slice:** third of the discount-code series (SP-Code-1 bulk-gen + SP-Code-2 analytics done). Adds a per-customer redemption cap to discount codes — an ENGINE change (money + tx + race-safety), the correctness-critical slice of the series.

---

## Context
Discount codes today have only a GLOBAL `usage_limit` (total redemptions across everyone, race-safe under a `FOR UPDATE` row lock; SP-Promo-1). There is no way to say "each customer may use `WELCOME10` once." This slice adds `per_customer_limit`: a cap on how many times a SINGLE customer may redeem a given code, counted GLOBALLY across all outlets (parallel to the global `usage_limit`, which is also not per-outlet).

The redemption path is `OrderService.resolvePromos` (order.go:805): each code row is loaded `SELECT … FROM discount_codes WHERE code=$1 AND is_active=true FOR UPDATE` (order.go:868) and that lock is held through `usage_count = usage_count + 1` (order.go:506) in the same tx — so any per-customer count added inside this window is race-safe for free. Prior redemptions are recorded in `orders.applied_discount_codes` (jsonb array of code strings, mig 0036). The shared validator `ValidateCode` (Go) has a 1:1 TS port `validateCode` (`apps/pos/src/cashier/promoValidate.ts`) that greys codes at apply-time; both receive a `PromoEvalContext` that already carries `HasCustomer`/`hasCustomer`.

## Decisions (locked during brainstorm)
1. **Cap scope = GLOBAL** (across all outlets), matching the existing global `usage_limit`. The count query has no outlet filter.
2. **A capped code REQUIRES a customer** at checkout. Enforced in TWO layers:
   - **requires-a-customer** → the SHARED validator (`ValidateCode` / `validateCode`), so the POS greys the code locally AND the server enforces it authoritatively (online reject / offline record+flag). New `ViolationRequiresCustomer`.
   - **the count** ("already at the cap?") → SERVER-ONLY (the POS cannot know redemption history offline), inside `resolvePromos` under the existing `FOR UPDATE` lock. New `ViolationPerCustomerCapReached`.
3. **Count = completed orders only** → `status='completed'`, so a refund frees a slot (self-heals), consistent with how `usage_count` refund-restore already works.
4. **Server-authoritative hybrid** (same as global `usage_limit`): online violation → 422 `ErrDiscountRejected`; offline → keep the order + `discount_warning` flag (POS can't verify history offline).
5. **Count against the merged-keeper customer id** — resolve the terminal keeper (`resolveMergedCustomer`) for the count so a merged customer's history carries.
6. **`per_customer_limit` is independent of `usage_limit`** — a code can have either, both, or neither. `NULL` = uncapped per-customer.
7. Authoring on BOTH the single-code form and the "Buat Massal" batch modal. Full slice: **migration 0042 + APK** (POS guard changes).

---

## 1. Schema — migration `0042_discount_code_per_customer_limit.sql`
```sql
ALTER TABLE discount_codes ADD COLUMN per_customer_limit integer;
```
`NULL` = no per-customer cap (default; all existing codes stay uncapped). No backfill. No index (the count query filters by `customer_id` on `orders`, which is already indexed; see §3).

## 2. OpenAPI + codegen
Add `perCustomerLimit` (`type: integer, nullable: true`) to: `DiscountCode`, the discount-code create/update input schema, and the batch-create input schema (SP-Code-1's batch body). Regenerate `api.gen.go` + `schema.d.ts` (`make gen-check`). Go sees `nullable.Nullable[int]`; TS sees `number | null`. Per [[openapi-nullable-ref-codegen-gotcha]], clearing it from TS uses `undefined`/omit.

## 3. Engine — the two enforcement layers

### 3a. Requires-a-customer (shared validator)
In `ValidateCode(row CodeRow, ec PromoEvalContext) []PromoViolation` (Go) and its TS port `validateCode(c, ctx)`:
```
if perCustomerLimit != nil && !hasCustomer → append ViolationRequiresCustomer
```
- `CodeRow` gains a `PerCustomerLimit *int`; the `discount_codes` SELECT in `resolvePromos` adds `per_customer_limit`.
- New violation constant `ViolationRequiresCustomer` + user message **"Kode ini butuh pelanggan terdaftar"**. Mirror the constant/message in the POS `Violation` enum + reason map; the POS greys the code with **"Pilih pelanggan dulu untuk kode ini"** at apply-time.
- This rides the EXISTING hybrid in `resolvePromos` (online → `reject`; offline → append to `violations`). No new control flow.

### 3b. Per-customer count (server-only, under the FOR UPDATE lock)
In `resolvePromos`, immediately after the code row is loaded `FOR UPDATE` and `ValidateCode` runs, when `row.PerCustomerLimit != nil && ec.HasCustomer`:
```sql
SELECT count(*) FROM orders
 WHERE customer_id = $1               -- the merged-keeper id
   AND status = 'completed'
   AND COALESCE(applied_discount_codes, '[]'::jsonb) ? $2   -- code is an array element
```
- `$1` = the keeper id (resolve `resolveMergedCustomer(ctx, tx, ec customer id)` — see §Plumbing).
- If `count >= *row.PerCustomerLimit` → `ViolationPerCustomerCapReached` → online `reject` / offline append+flag. Message **"Pelanggan sudah mencapai batas pemakaian kode ini"**.
- Race-safe: the code row is already `FOR UPDATE`-locked; two concurrent orders for the same code serialize on that lock, so the count each sees is authoritative at commit. (The cap is per-CODE not per-customer-row, but the code-row lock is the existing serialization point for that code's redemptions — sufficient, since we only care about redemptions of THIS code.)
- Applies to BOTH linked and unlinked codes (place the check on the common path after the code row loads, before the linked/unlinked branch).

### Plumbing: customer id into `resolvePromos`
`resolvePromos` currently receives `ec PromoEvalContext` (has `HasCustomer` but not the id) and is called at order.go:162, BEFORE the merge-resolve at order.go:235. Add the customer id to what `resolvePromos` can see (extend `PromoEvalContext` with `CustomerID string`, set alongside `HasCustomer` at order.go:224). Inside the count, resolve the keeper: `keeper, _ := resolveMergedCustomer(ctx, tx, ec.CustomerID)` (fall back to the raw id on error). This does not change the later order-write merge-resolve.

## 4. Backoffice authoring
- **Single-code form** (`Promotions.tsx` code modal): add **"Batas per pelanggan"** number input, helper "kosong = tak terbatas", maps to `perCustomerLimit` (empty → omit/undefined so it clears to null). Mirror `openEditPromo`/edit-populate so editing a code round-trips the value (the SP-Promo-4 lesson: trace every read+write path for the new field).
- **Batch modal** (`DiscountCodeBatchModal.tsx`, SP-Code-1): add the same field to the shared batch settings so a generated batch shares the per-customer cap.
- Client `client.ts`: the create/update/batch payload types already flow from the regenerated schema; ensure the field is passed through (no envelope change).

## 5. POS
- `perCustomerLimit` rides on the synced `DiscountCode` (OpenAPI schema) — no new sync.
- `validateCode` gains the §3a requires-customer guard; `PromoEvalContext.hasCustomer` already set from `state.selectedCustomer` (useCart.ts:68).
- Cap-reached (§3b) is NOT shown locally — it surfaces as the checkout 422 (online) or a `discount_warning` (offline), consistent with the global `usage_limit` behavior.

## 6. Testing & verification
- **Go unit** (`ValidateCode`): table test — `per_customer_limit` set + no customer → `ViolationRequiresCustomer`; set + customer → no requires-customer violation; nil → never.
- **TS unit** (`validateCode`, vitest): the mirror cases (greys when capped + no customer).
- **Live e2e** (throwaway `cmd/codepercust`, real `OrderService` + real migrations 0001→0042, deleted, zero-residue): seed a code `per_customer_limit=1`; customer A 1st redemption → OK (order completes); customer A 2nd redemption online → 422 `ViolationPerCustomerCapReached`; customer A 2nd OFFLINE → order kept + `discount_warning`; customer B → OK; **refund A's 1st → A can redeem again** (self-heal); anonymous order with the capped code online → 422 `ViolationRequiresCustomer`; a code with `usage_limit=1` but `per_customer_limit` NULL still behaves as before (global cap independent). Run against Neon per [[neon-e2e-verification]] (user-authorized, per-request for writes).
- **Gap-class:** `make gen-check` clean; the new field appears in read (SELECT) AND write (INSERT/UPDATE) repo SQL AND OpenAPI AND both forms (the SP-Promo-3a lesson: adding a column = trace read json + write INSERT/UPDATE, not just OpenAPI+form).
- **Local gate:** go build+vet+test+gen-check; POS tsc+vite+vitest; backoffice tsc+vite.
- **Deploy:** migration 0042 (`gcloud run deploy`), `/readyz` 200; authed smoke; **new APK** (POS guard changed).

## 7. Model routing & rollout
Sonnet implements; **Opus** reviews order.go/`resolvePromos` (the count query + hybrid + merge-keeper + race-safety) and type-gen; Sonnet the backoffice/POS wiring. Final whole-branch Opus review. Deploy backend (mig 0042) + Cloudflare backoffice + APK.

## Out of scope / deferred
- **SP-Code-4 (customer-assigned codes)** — a code redeemable by ONE specific customer (`customer_id` on the code); reuses this slice's customer-at-redemption gating (requires-customer + the shared-validator + server-authoritative pattern). Built next.
- Per-outlet caps (decided global).
- An apply-time online preview pre-check for cap-reached (decided: rely on the checkout 422; a preview endpoint is useless offline anyway).
- Showing the cashier a customer's remaining redemptions (report/UX nicety, not this slice).
