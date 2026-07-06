# SP-Code-1 — Bulk Discount-Code Generation (Design)

**Date:** 2026-07-06
**Branch:** `prod-hardening`
**Status:** Design approved — build
**Slice:** first of the discount-code enhancement series (SP-Code-1..4: bulk-gen → analytics → per-customer cap → customer-assigned). SP-Code-1 = generate many unique codes at once for campaigns/giveaways.

---

## Context
Discount-code **mechanics** are complete (validation, race-safe global usage limit, refund restores quota, stacking/combinability, promotion linkage). **Authoring** today: create one code at a time (`DiscountCodeFormModal` — code/type/value/minPurchase/usageLimit/dates/combinable/promotionId), with a "Generate" button that fills a single random code via `generateCode(8)` (`apps/backoffice/src/lib/csvUtils.ts`, charset `A–Z0–9`), plus CSV/XLSX export of the whole list. **Missing:** generating a BATCH of N unique codes (e.g. 500 single-use vouchers) with shared settings. That is SP-Code-1.

## Decisions (locked during brainstorm)
1. **Server-side batch generation** (the only collision-safe way against the live `UNIQUE(code)` table): a new `POST /api/v1/discount-codes/batch` endpoint generates + inserts N codes, retrying each on a unique-collision.
2. **Code = `prefix` (optional, uppercased) + random suffix.** Suffix uses an **unambiguous charset** (drop `O/0/1/I`), default length **6**. e.g. `RAYA` + `K7M9QX`.
3. **Cap `count` at 500** per batch.
4. **Shared settings** for all codes in the batch (type/value/minPurchase/usageLimit/startDate/endDate/combinable/promotionId); only the code string differs. **Default `usageLimit` = 1** in the batch UI (single-use voucher).
5. **Backoffice "Buat Massal" modal** + after-generate: refetch the list, toast, and **download a CSV of just this batch**.
6. **No migration** (reuses `discount_codes`); no POS/APK. Generated codes redeem through the identical validated path.

---

## 1. Backend — batch endpoint + repo
- **Repo** `write/repo.go`: `CreateDiscountCodeBatch(ctx, b DiscountCodeBatch) ([]api.DiscountCode, error)` (or return the created `code` strings + ids). `DiscountCodeBatch` = the shared `DiscountCode` fields + `Count int`, `Prefix string`, `SuffixLength int`.
  - One `Pool.Begin` tx. Loop `Count` times: generate `code = Prefix + randSuffix(SuffixLength)` (crypto/rand over the unambiguous charset `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`), attempt the SAME INSERT as `CreateDiscountCode`. On a unique-violation (pg error code `23505` — detect via `pgconn.PgError`), regenerate the suffix + retry (bounded, e.g. 10 attempts/code); if still colliding, abort the whole tx → error. Collect the created rows.
  - Commit; return the created codes (id + code + settings) so the UI can list/download them.
- **Validation** (`write` boundary, reuse/extend the single-code validation): `1 ≤ Count ≤ 500`; `4 ≤ SuffixLength ≤ 12`; `Prefix` uppercase-alphanumeric, length ≤ 16; `type ∈ {percentage,fixed}`; value/min sane (mirror the existing single-code checks). Reject with a clear message.
- **Handler** `handlers/`: `CreateDiscountCodeBatch` — decode `api.DiscountCodeBatchInput` → `write.DiscountCodeBatch` → repo → `writeJSON` the created codes as a list response. Gate **`manage_promotions`** (same as `CreateDiscountCode`).
- **Route** `server.go`: `r.Post("/discount-codes/batch", h.CreateDiscountCodeBatch)` in the same `manage_promotions` group as the other discount-code writes.

## 2. OpenAPI + codegen
- `DiscountCodeBatchInput` schema = the `DiscountCodeInput` fields (type/value/minPurchase/usageLimit/isActive/startDate/endDate/combinable/promotionId) **minus `code`**, **plus** `count` (int), `prefix` (string), `suffixLength` (int).
- Path `POST /api/v1/discount-codes/batch` → 200 returning `DiscountCodeListResponse` (reuse the existing list-response schema: `{ data: DiscountCode[] }`).
- Regenerate `api.gen.go` + `schema.d.ts` (`make gen-check`). Referencing the new input schema materializes the Go/TS types.

## 3. Client (`packages/api/src/client.ts`)
- `createDiscountCodeBatch: (input: DiscountCodeBatchInput) => Promise<DiscountCode[]>` — `POST ${API}/discount-codes/batch`, returning the `data` array (mirror how `createIngredientTransfer`/the single `createDiscountCode` POST, but return the created list — use `request<{data: DiscountCode[]}>('POST', …, input).then(r => r.data)` or the repo's list-envelope shape; match what the handler writes).

## 4. Backoffice — "Buat Massal" modal (`Promotions.tsx` + a new modal)
- Add a **"Buat Massal"** button on the Kode Diskon tab header (next to "Tambah Kode").
- New `DiscountCodeBatchModal.tsx` (mirror `DiscountCodeFormModal` structure/props): inputs for **Jumlah** (count, 1–500), **Prefix** (optional), **Panjang kode** (suffixLength, default 6), + the shared settings reused from the single-code form (Tautkan ke promosi, Tipe, Nilai, Min. Beli, **Batas Pakai per kode** default 1, dates, combinable). Client-side guard: count 1–500, suffixLength 4–12, value/type valid — block the Generate button on error.
- On **Generate**: `api.createDiscountCodeBatch(input)` → on success: refetch the codes list (`dcq`), close the modal, show a success toast ("N kode dibuat"), and trigger a **CSV download of just the returned batch** (reuse `exportToCSV` from `csvUtils` with the batch rows: Kode + settings). Handle/​show the error message on failure.

## 5. Testing & verification
- **Go:** table test for `randSuffix` (length, charset excludes O/0/1/I) + the batch validation (count/suffixLength/prefix bounds). The tx/collision path (DB-bound) is proven by the live e2e (no unit-DB harness).
- **Live e2e** (throwaway `cmd/codebatch`, real repo vs DB, deleted, zero-residue): generate a batch of N (e.g. 5) with a prefix → assert N unique rows created with the shared settings + the prefix + unambiguous suffix; a forced-collision case (seed a code, then a 1-count batch that would collide) still succeeds via retry; cleanup deletes all `E2E-*` codes. (Run vs Neon via the [[neon-e2e-verification]] secret-injection if writing to Neon; else local.)
- **Gap-class / codegen:** `make gen-check` clean; `DiscountCodeBatchInput` present in `api.gen.go` + `schema.d.ts`.
- **Local gate:** go build+test+gen-check; backoffice tsc+vite.
- **USER-PENDING (live):** open Kode Diskon → Buat Massal → generate a small batch → the codes appear in the list + the CSV downloads; spot-redeem one at the POS (it validates like any code).

## 6. Model routing & rollout
Sonnet implements (backend batch + handler/route + client + modal); **Opus** reviews the batch repo (collision/retry/tx correctness) + the type-gen; Haiku/Sonnet the modal. Deploy (no migration) + Cloudflare backoffice; **no APK**.

## Out of scope / deferred
- Per-customer cap (SP-Code-3), customer-assigned codes (SP-Code-4), redemption analytics (SP-Code-2).
- QR generation, printable voucher templates.
- Editing a whole batch at once (each generated code is an independent row, edited singly via the existing form).
