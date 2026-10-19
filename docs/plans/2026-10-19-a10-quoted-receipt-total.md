# A10 keep the quoted receipt total: plan (2026-10-19)

## State
DONE: server keeps `amountPaid` and judges change/`tender_warning` (A09, mig 0046); promo/reward/bundle drift sets `discount_warning` (mig 0035); client `discountBreakdown`/`discountLabel` stored as sent; client order number kept.
LEFT: the POS never sends the total it showed/printed (CashierScreen.tsx:668-685, sync.go:616 `orderPayload`, writes.go ~925 `createOrderBody` have no field). `quoted_total` is written with the server's OWN recomputed total
(order.go:500, `$28`). Printed lines are lost (order_items store lines after resolveRewardLines/resolveBundleLines reprice). No price/rule version recorded; no mismatch flag or display.

## Fix
POS sends `quotedTotal` + a small `receiptSnapshot` in the order payload. Server stores them unchanged, compares in cents with the existing +-Rp1 tolerance (`tenderToleranceCents`), and on mismatch FLAGS on both routes, never rejects.
Backoffice shows a "Struk" warning badge. Old queued orders with no quote keep syncing: NULL, no flag. Needs one additive migration (0058), OpenAPI + regenerated types, new PG gate "QT" port 56460. NO APK: all POS changes are web layer, OTA to APK 2.1; older APKs keep sending the legacy payload.

## Behaviour
- Quote = the money and lines the cashier showed and printed. POS builds the receipt money+lines ONCE inside the sale gate after `reserveOrderNo`, embeds the same object as `quotedTotal` (= derived.total after redemption) + `receiptSnapshot`, then prints that same object.
  `receiptSnapshot` = `{v:1, refVersion: snapshot localVersion(), subtotal, discountAmount, surchargeAmount, taxAmount, redeemAmount, total, amountPaid, change, lines:[{productId, variantSize, name, qty, unitPrice, amount, isReward?, isBundle?}]}`.
  NO customer phone/name in it (new PII, A30).
- Server in `createOrder` (backend/internal/service/order.go): `CreateOrderInput.QuotedTotal *float64`, `ReceiptSnapshot json.RawMessage`. Judge the quote only AFTER the `processed_keys` replay guard (~line 170).
  New pure `evaluateQuote(quoted *float64, snap, finalTotal) (stored *float64, reason string)` in new `service/quote.go`: nil -> NULL, no flag; NaN/negative/above numeric(14,2)/snapshot > 64 KB -> stored NULL, reason `quote_invalid`, sale ACCEPTED;
  difference > 100 cents -> reason `quote_mismatch`. Mismatch is flag-only on both routes (slice-8 owner answer 5). `orders.total` stays the server recompute; tender rules, shift expected cash, reports, refunds unchanged.
- Migration `backend/internal/db/migrations/0058_order_receipt_quote.sql`: `ADD COLUMN IF NOT EXISTS receipt_snapshot jsonb`, `quote_warning boolean NOT NULL DEFAULT false`, `quote_warning_reason text`.
  DECISION 2026-10-19 (session lead): do NOT rewrite existing rows (the planner proposed `UPDATE orders SET quoted_total=NULL`); pre-0058 `quoted_total` values are server recomputes (== total), and `receipt_snapshot IS NULL` marks "no real quote". Document this in the migration comment.
  (Migrations are tracked by file name, db.go:79-125, so 0058 applies whether A15 Phase B's 0057 lands before or after; 0057 stays reserved for A15.)
- Read path `backend/internal/read/repo.go:961 orderObj`: add `'quotedTotal',o.quoted_total,'quoteWarning',o.quote_warning,'quoteWarningReason',o.quote_warning_reason`. Snapshot stays OUT of the list JSON.

## Steps (fresh worktree off prod-hardening with A23 merged first; tests first)
1 Go unit tests (red) `service/quote_test.go` table over evaluateQuote: nil/equal/+-Rp1/+Rp2/-Rp2/NaN/negative/oversized/oversized snapshot. [Opus]
2 PG gate test (red) `backend/internal/handlers/quoted_receipt_integration_test.go` `TestQuotedReceiptPostgres`, register in scripts/ci/postgres_gate.py as ("QT", ..., 56461, "qt") (56460 is taken by gate PL from A23; check the highest port on the base first). Cases: legacy batch payload -> NULL, no flag; matching quote -> stored, no flag;
   catalog/tax drift -> total = server value, quoted_total = captured, `quote_mismatch`, amount_paid = captured; same-key replay not re-judged, no second flag; POST /orders mismatch -> 200 + flagged (not 422); invalid quote -> accepted + `quote_invalid`; receipt_snapshot unchanged after a refund.
   Also flip sale_input_integration_test.go:308 from `quoted != 110000` to `quoted IS NULL` (that assertion exposed this gap). [Opus]
3 Backend [Opus]: migration, quote.go, createOrder wiring (INSERT columns/placeholders/reasons), `orderPayload`, `createOrderBody`, both CreateOrderInput builders (sync.go:352, writes.go:980), orderObj.
4 OpenAPI + generated types [Opus]: Order gets quotedTotal (number, double, nullable), quoteWarning (boolean), quoteWarningReason (nullable string); CreateOrderRequest gets quotedTotal (number, double, nullable) and receiptSnapshot as an INLINE object with additionalProperties (NOT a $ref: codegen drops nullable on $ref). Leave existing float32 input fields alone.
   Regenerate BOTH `make gen-go` (api.gen.go) and `corepack pnpm --filter @mandalika/api gen` (schema.d.ts); `go run ./cmd/codegen -check` and `corepack pnpm gen:check` must pass.
5 Vitest (red) then POS [Opus capture/outbox]: pure `apps/pos/src/cashier/receiptQuote.ts` `buildReceiptQuote(state, derived, tender, refVersion)` + test (payload quotedTotal === printed ReceiptData.total; snapshot lines equal printed lines; no phone/name). Wire into CashierScreen.tsx:657-718 so one object feeds payload and receipt.
   Expose read-only `engine.referenceVersion()` (snapshot.localVersion()) in packages/sync/src/engine.ts. packages/sync test: a legacy queued order with no quote flushes byte-identical.
6 Backoffice [Haiku]: Orders.tsx ~248 add a "Struk" warning badge next to the "Bayar" one, title = quoted vs server total and difference; expanded row shows "Total di struk".
7 Gates: full PG gate `python scripts/ci/postgres_gate.py --no-race --output artifacts/postgres/result.json`, quality:ci, browser:ci; final Opus review of the whole diff.
8 Release (owner go-ahead only): tablets at 0 pending -> backend deploy -> push (backoffice) -> `make ota-release`. No APK.

## Risks
Old outbox items: absent quote = NULL no flag; invalid quote = NULL + flagged, never rejected (no dead-letters). Rounding: cents with +-Rp1; known drift (points redemption: client Math.round(points*rate) pricing.ts:401 vs server unrounded order.go:346) stays under Rp1;
real repricing raises `quote_mismatch` alongside `discount_warning`/`tender_warning` (intended double flag). A11 receipt fingerprint (service/receipts.go:49) hashes the raw payload: queued items keep bytes+hash; new fields only affect new sales. Neither sync batch nor decodeWrite rejects unknown fields (old backend ignores them).
During Cloud Run rollout the old revision still writes quoted_total=finalTotal for a few orders (negligible on test data). Deferred: reprint of original receipt from history depends on the local receipt store (A41); snapshot is stored but not exposed in the API yet.

## Owner question (default taken, unchanged behaviour)
When an offline sale's receipt total differs from the server's recompute, which total counts for shift expected cash and reports? DEFAULT: the server total, unchanged; the difference is visible via the "Struk" badge. Owner may overrule later.
