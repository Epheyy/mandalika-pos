# P0 slice 8 — A09 tender rules (plan, 2026-10-11)

Planned by the Opus planner (read-only) against `prod-hardening` @ `db1a275` (backend identical to
live `249fd35`).

**Owner answers (2026-10-11), these override the text below:**
1. Yes — "reject online" applies to direct `POST /orders` only; tablet sales accept-and-flag.
2. Migration 0046 **approved** (still confirm with the owner right before the deploy command).
3. Non-cash with missing/0 `amountPaid`: store 0 and flag.
4. Discount permission split out to slice 8b.
5. Online non-cash mismatch: flag only (online rejects `cash_short` only).
6. **Tolerance ±Rp1**: a difference of ≤ 100 cents (|captured−due| ≤ Rp1) is NOT a shortfall /
   mismatch. Cash short = captured < due − Rp1. Test case 11 becomes: cash 99999 → passes
   (change 0, no flag); cash 99998.99 → 422 direct / flag batch. For cash within tolerance below
   due, change = 0 and amount_paid = captured.
7. Badge only now.

## 0. Facts that limit what this slice can promise

1. **Online vs offline is decided by route.** `Offline:false` is hard-coded for `POST /orders`
   (`handlers/writes.go:982`); `Offline:true` for `/sync/batch` (`sync/sync.go:304`). The POS sends
   every sale through the outbox to `/sync/batch` (`CashierScreen.tsx:645`). So "reject online" only
   fires on direct `POST /orders` (tests / hand-crafted calls); **every tablet sale gets
   accept-and-flag** (same as SP-Promo-1). A client "captured online" bit is untrusted until slice 6/10.
2. **The POS already blocks cash shortfall at capture** (`CheckoutPanel.tsx:103-104`, button disabled
   `:447`). A server-side shortfall = forged payload or server recompute drift.
3. **No client total in the payload** (`orderPayload`, `sync.go:519-544`). Flags also fire on drift
   (e.g. points: client `Math.round(points*rate)` `pricing.ts:401`, server unrounded `order.go:296`).
   Real fix = send/keep `quotedTotal` (A10, APK) — out of scope.

## 1. Current behaviour

- `order.go:403-412`: cash → `change = max(0, paid-total)` (shortfall silently stored); non-cash →
  `amountPaid = finalTotal` (captured amount discarded). Persisted `:432`.
- `order_input.go:88-115`: paid finite, ≥0, ≤numeric(14,2); method non-empty, free-form IDs. No
  sufficiency rule.
- **Negative quantity: closed** (`validateSaleItems` `order_input.go:59-61`, run at `order.go:143` and
  `:227`; covered by `TestSaleInputNegativeAndZeroQuantityRegression` + S0C).
- **Discount permission: none exists** (no permission, no cap; `AdjustmentDrawer.tsx:77`). Recommend
  split to slice 8b with owner policy (who / cap / offline override via A08 PIN).
- Shift expected cash (`shift.go:119-122`) and report by-method (`read/reports.go:35-37`) sum
  `total`, not `amount_paid` → keeping captured non-cash amounts moves no figures. Refunds don't read
  `amount_paid`/`change`. No split tenders exist.

## 2. Rules (owner decisions 6 and 7)

Pure `evaluateTender(method, captured, due) (amountPaid, change, reason)` in `order_input.go`; compare
in whole cents (`math.Round(x*100)`), zero tolerance.
- Cash (exact `"cash"`): captured ≥ due → change = captured−due; captured < due → keep captured,
  change 0, `cash_short`.
- Non-cash: keep captured, change 0; ≠ due → `noncash_amount_mismatch` (over or under).
- Zero total: cash any ≥0 passes (change = captured); non-cash 0 passes, >0 flagged.
- Online (`!in.Offline`) with reason → `ErrTenderRejected` (apperr.Rejected), 422 next to
  `ErrDiscountRejected` mapping (`writes.go:985-989`). Recommended: online rejects `cash_short` only.
- Offline with reason → accept, `tender_warning=true`, `tender_warning_reason=<token>`.
- Placement: after `finalTotal` validated (`order.go:306-309`), before stock loop (`:357`); after the
  idempotency lookup (`:131-140`) so replays are never re-judged. Replace `:403-412`.

## 3. Data — migration `0046_order_tender_warning.sql` (owner approval required before deploy)

```sql
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tender_warning        boolean NOT NULL DEFAULT false;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tender_warning_reason text;
```
Additive; old revision unaffected. Do not reuse `discount_warning` ("⚠ Diskon" badge).
Full path: INSERT `order.go:420-435` (append params $37/$38); read JSON `orderObj` `read/repo.go:968`;
OpenAPI `Order` (`tenderWarning` bool, `tenderWarningReason` nullable string); regen Go + TS,
`gen:check` clean; backoffice "⚠ Bayar" badge in `Orders.tsx:183` with reason tooltip. No POS change.

## 4. Wire compatibility

Request payloads unchanged; queued old-format sales decode as today; batch never rejects on tender.
Response gains two optional fields. Non-cash orders now store the client's `amountPaid` (POS sends
`derived.total` since `d648d5f`, so normally identical).

## 5. Tests

Failing-first PostgreSQL gate **TD** `handlers/tender_rules_integration_test.go`
`TestTenderRulesPostgres` (env `MANDALIKA_TD_TEST_DSN`/`_DATA_DIR`, guard `127.0.0.1:56447`,
db `mandalika_td_synthetic`, user `td_test`; copy guard from `sale_input_integration_test.go:29-62`),
registered in `scripts/ci/postgres_gate.py`. Product 100000:

| # | Route | Method / paid | Expect |
|---|---|---|---|
| 1 | direct | cash 90000 | 422, zero rows changed |
| 2 | batch | cash 90000 | ok; paid 90000, change 0, flag cash_short; stock −1 |
| 3 | batch | qris 95000 | ok; paid 95000, flag noncash_amount_mismatch |
| 4 | direct | qris 95000 | per Q5 (recommended 201 + flag) |
| 5 | both | cash 150000 | change 50000, no flag |
| 6 | both | qris 100000 | no flag |
| 7 | both | total 0, cash 0 / qris 0 | ok, no flag |
| 8 | batch | tax raised to 10% after capture, cash 100000 | flagged cash_short, captured kept |
| 9 | batch | replay case 2 | duplicate, one row, flag unchanged |
| 10 | read | GET /orders/{id} case 2 | JSON tenderWarning/Reason (read-path guard) |
| 11 | direct | cash 99999.99 | 422 (cents, no tolerance) |

Unit: `evaluateTender` table (+ custom method `bca`, non-cash over); `createOrder` seam test (online
reject → 0 writes/commits; offline → flag args).
Existing tests that change (justify each, never loosen): `TestSaleInputPreservesKnownReceiptAndQ08Shortage`
(direct paid → 110000, add batch flag assertion); S0C `valid/bca` (asserted the overwrite; per Q3);
run-and-check S0C mixed-batch shortage, `semantic_promotion_keys_integration_test.go:126-128` direct
mode, `guest_browser_orders.json`.

## 6. Deploy (hidden revision)

Preconditions: owner approves 0046 (migrations run at boot — a no-traffic revision still migrates the
shared Neon DB); tablets at 0 pending; CI green incl. TD.
```sh
gcloud run deploy mandalika-pos --source backend --region asia-southeast2 --no-traffic --tag td --quiet
curl -s https://td---<host>/readyz
gcloud run services update-traffic mandalika-pos --region asia-southeast2 --to-tags td=100
# rollback (0046 stays, harmless):
gcloud run services update-traffic mandalika-pos --region asia-southeast2 --to-revisions mandalika-pos-00086-pac=100
```
Smoke on tag URL: direct cash-short → 422; throwaway batch cash-short flagged + visible via GET;
normal qris unflagged; clean up. Badge commit must NOT use `[CF-Pages-Skip]`.

## 7. Implementer tasks

T1 TD gate (fails on current code) → T2 migration → T3 `evaluateTender` + unit table → T4 wire into
`createOrder` → T5 422 mapping → T6 read JSON → T7 OpenAPI + regen → T8 update changed tests →
T9 backoffice badge → T10 HANDOFF → T11 deploy after owner OK. Opus review on T1–T8, T11.

## 8. Risks

False flags from recompute drift; online reject protects only direct API use; cash-short order
inflates shift expected cash by the shortfall (explained by flag, not reconciled); only exact `"cash"`
is cash; migration applies at hidden deploy.

## 9. Owner questions

1. Accept that "reject online" = direct `POST /orders` only (all tablet sales accept-and-flag)? *Rec: yes.*
2. Approve migration 0046? 
3. Non-cash with missing/0 `amountPaid`: store 0 + flag (*rec*), or treat as total?
4. Split discount permission into slice 8b? *Rec: yes.*
5. Online non-cash mismatch: flag only (*rec*) or reject?
6. Tolerance exact cents (*rec*) or ±Rp1?
7. Badge only now, filter/report later? *Rec: yes.*

Not verified: exact `--no-traffic --tag` command used for 00086-pac; whether semantic-promotion-key
direct cases trip 422; count of live orders already matching (`SELECT count(*) FROM orders WHERE
payment_method='cash' AND amount_paid < total`).

## 2026-10-11 hold: cash-method identity bug (found before deploy)

Read-only count on the test DB: live cash method id is **`tunai`** (app_settings.payment_methods),
used by every POS cash sale since ~2026-06-11, but code compares the literal `'cash'`: POS
CheckoutPanel cash input/change/short-guard, CashierScreen amountPaid/change, ShiftRecapPanel,
**server shift expected cash (`service/shift.go:119`)**, and slice 8 `order.go:405`. Owner decision:
add an "is cash" flag to PaymentMethodConfig (default true for id `cash`/`tunai`), read by backend +
POS; **hold slice 8 deploy until the cash-identity fix ships with it.**

## Slice 8c — payment-method cash identity (plan, Opus planner, 2026-10-11)

Base `fix/a09-tender-rules` @ df9cf7e; no migration; backend ships on the slice 8 deploy; POS needs
APK/OTA. Key findings: literal `'cash'` in `service/tender.go:15`, `service/shift.go:119`, POS
CheckoutPanel/CashierScreen/ShiftRecapPanel, backoffice Orders.tsx:244 + filters + TransaksiSection
delete list; **read path decodes into typed `api.PaymentMethodConfig`, so `isCash` is stripped unless
OpenAPI+regen carry it** (gap-class; PG round-trip test required); unvalidated paymentMethods writes
can break sync pull for every tablet. Design: `IsCashMethod(methods,id)` (explicit flag wins; default
`cash`/`tunai` case-insensitive, also for ids not in config); `loadAppSettings` returns payment
methods (same SELECT); `evaluateTender(isCash,…)`; shift close sums cash in Go per flag at close time
(snapshot; closed shifts never change); no jsonb backfill; TS `isCashMethod` in packages/types + POS
`cashier/tender.ts`; backoffice toggle "Tunai (masuk laci kas)" showing the resolved value; write
validation (strict decode, no empty/duplicate ids → 400). TD gate additions 14–18 failing-first.
Tasks T1–T12 (Opus review on all logic; Haiku on literals/docs). Old APKs: tunai now cash, paid=total
⇒ change 0, no flag (drift residual as in slice 8).
