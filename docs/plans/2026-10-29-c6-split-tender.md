# C6 split tender: implementation plan

Date 2026-10-29 · base `prod-hardening` adb07723 (live: backend `00147-giy`, migrations to 0078, POS OTA 2.4.0) · planner: Opus (read-only, plan only, no code changed).
Source rows: UX plan `docs/plans/2026-10-27-pos-ux-direction.md` Fase C row C6 (`:514`), W2 Bayar (`:331-357`), D-6 (`:568`, split tender = C6 after the window), D-3 cash chips (`:565`), D-21 reference number (`:583`). Audit: A09 (`AUDIT_REPORT.md:232-242`; tracker `docs/AUDIT_COVERAGE_TRACKER.md:1113-1123`; slice 8/8c plan `docs/plans/2026-10-11-p0-slice8-a09-tender-rules.md`).
Every claim about current behaviour cites `path:line` on adb07723. ERP claims cite erp-flamboyan `69ababa8`. Owner decisions continue the C4 register: D-50 onward (section 3).

**Release timing: nothing in this plan is released before the 2 Nov demo unless the owner says otherwise.** Code may be built and merged; deploy, OTA and enabling the feature wait.

---

## 0. Read this first

1. **The POS can never be allowed to send a split before the server can store one, and the server cannot tell.**
   - The sync `order` case decodes with plain `json.Unmarshal` (`backend/internal/sync/sync.go:313-316`) into `orderPayload` (`:575-602`), which has one `PaymentMethod` and one `AmountPaid` (`:584-585`). An unknown `tenders` key is silently dropped.
   - The direct route is the same (`handlers/orders.go:55` → `decodeWrite` → `httpx.DecodeLoose`, `handlers/writes.go:34-41`).
   - So a split sale that reaches a server without C6a (an old revision, or a rollback) is stored as one method, with no error and no flag.
   - The plan therefore gates the POS UI on a **server-delivered setting** (`splitTenderEnabled`, default off). An old server never sends it, so a tablet that pulled from one hides split payment.
   - Tablets cache the setting until the next content change, so after enabling, a rollback must turn the setting off first (2.5).
   - The usual release order (server first) and a no-rollback rule (2.5) come on top of that.
2. **Money readers must move in the backend slice, not later** (the same lesson as C4a).
   - Every by-method reader keys on the single `orders.payment_method` column: shift close, reports, order filter, ERP, POS recap and backoffice totals (section 1.4).
   - They switch to tender lines in C6a, before any tablet can send a split. Only display, CSV and the admin UI wait for C6c.
3. **Refunds today copy the sale's method.**
   - `refund.go:124-129` reads `orders.payment_method`, and `:254-260` writes it into `order_refunds.payment_method`. The 0077 catch-up trigger does the same (`0077_order_refunds.sql:117-121`).
   - Neither the refund payload nor `RefundRequest` (`openapi.yaml:2175-2189`) carries a method. `RefundPayload.paymentMethod` in `apps/pos/src/cashier/refundView.ts:126,166` is a display snapshot the server never reads.
   - A split order therefore needs a payout rule, or its refunds are recorded as method `split` and drop out of the cash drawer and the ERP tender.
4. **Pre-existing gaps found while tracing (not caused by C6):**
   - **Tunai and custom methods never reach the ERP.**
     - The ERP relay keeps only the ids `cash/card/transfer/qris` (`integration/erp/payload.go:38-40, 216-218`).
     - The live cash method id is `tunai` (slice 8c, `2026-10-11-p0-slice8-a09-tender-rules.md:153-160`).
     - So **tablet cash sales send no tender to the ERP today**, and neither does any custom method id.
     - D-61 proposes fixing this in C6a, because C6a rewrites the same function.
   - **Custom non-cash ids land in no shift bucket.** The shift close hard-codes `card/transfer/qris` (`service/shift.go:196-199`), so a sale with any other non-cash id is in no bucket. Not fixed here; see section 6.
   - **The backoffice and server key refunds by different methods.** The backoffice report oracle keys refunds by the order's method (`apps/backoffice/src/screens/reports/reportTotals.ts:120`); the server keys them by the refund row's method (`read/reports.go:45, 69-71`).
     - They agree today only because the two are always equal. C6 makes them differ, so C6a fixes the client.
   - **D-21 was never built.** The "No. referensi" field was decided Yes on 2026-10-27, but no reference field exists anywhere in the POS, sync or types (scout grep; `CheckoutPanel.tsx` has none). C6b adds it per tender line (D-59).

## 0.1 TL;DR (recommendation)

- **Tenders become rows.** Add `order_tenders` (one row per payment line: method, applied `amount`, `tendered`, `change`, `reference`).
  - **No backfill.** Readers use one rule: an order's tender lines are its `order_tenders` rows. When it has none, they are one synthetic row `(payment_method, applied = total, tendered = amount_paid, change)`, which is exactly how every reader treats an order today.
  - That rule covers pre-C6 orders, orders written by the old revision during the deploy, fixtures, `fsmigrate` and a rollback.
- **Σ applied = `orders.total` for every order.** The server allocates; the captured amounts are kept verbatim in `tendered`.
  - Non-cash lines apply what was charged. The single cash line takes the rest and gives the change.
  - Shortfall and drift are attributed as today and flagged (D-55).
  - Because the sum always equals the total, every by-method reader still adds up to `total_sales`, and for every pre-C6 order the new reader SQL gives byte-identical figures.
- **Wire:**
  - The sale payload gains `tenders: [{method, amount, reference?}]`; the POS sends it on every sale.
  - The scalar `paymentMethod` / `amountPaid` stay as a summary for older readers and the server ignores them when `tenders` is present.
  - An old payload (2.4.0, APK builtin) takes the unchanged legacy path, so `evaluateTender` (`service/tender.go:30-49`) and the TD gate stay byte-identical.
- **`orders.payment_method`:**
  - It is the shared method when every line uses one method, otherwise the reserved sentinel `split` (label "Campuran", D-60).
  - The settings write rejects `split` as a configured id.
  - Old readers that were missed show a visible `split` bucket rather than silently wrong cash.
- **Refunds of split orders:**
  - The cashier picks the payout method, defaulting to cash when the sale had cash, else the largest line (D-56).
  - Payloads with no method (2.4.0, builtin, the old backoffice form) and the replaced 0077 trigger use the same default (D-58).
  - Single-method orders keep today's rule.
- **Invariants:**
  - the tender sum covers the total;
  - change comes only from cash;
  - at most one cash line;
  - no zero or negative lines;
  - at most 4 lines.
  - They are enforced in the POS UI, in a TS twin of the server allocator (shared golden vectors) and on the server, which is authoritative (section 2.3).
- **Slices:**
  - **C6a:** backend, migration 0079, every money reader, ERP tenders, backoffice money totals, and the setting (default off).
  - **C6b:** the POS OTA: W2 split mode, receipt, recap, refund payout chips, and the checkout draft that survives an app kill.
  - **C6c:** backoffice display, CSV, the toggle and the admin refund payout.
  - **Then the owner enables the setting.** All of it lands after the demo.
- **Owner decisions:** D-50..D-66 (section 3).
- **Review:** the Opus reviewer's findings are folded in (section 7).

---

## 1. Current behaviour (single tender, end to end)

### 1.1 POS capture
- **Tender math.**
  - `cashTender(isCash, paidInput, total)` (`apps/pos/src/cashier/tender.ts:14-20`).
  - Non-cash, or a blank cash input, returns `amountPaid = total` with no change (`:15`). The blank-means-exact rule is owner 8c Q1.
  - A typed cash amount below the total is short and blocked (`:18`); at or above it gives change (`:19`).
  - Cash identity comes from `isCashMethod` (`packages/types/src/paymentMethod.ts:14-19`): the explicit `isCash` flag wins, otherwise the ids `cash`/`tunai`.
- **Checkout sheet** (`CheckoutPanel.tsx`).
  - Props: one `paymentMethod` and one raw `amountPaid` string (`:34-35`), and the callbacks `onPaymentMethodChange` / `onAmountPaidChange` / `onConfirm` (`:55-57`).
  - Method chips come from the enabled methods (`:121, :362-374`).
  - Cash input and the D-3 chips come from `quickCashAmounts(total)` (`:380-418`, `apps/pos/src/lib/quickCash.ts:7-11`).
  - Kembalian and Kurang (`:420-429`).
  - Konfirmasi is disabled while processing or cash-short (`:450`).
  - There is no reference field. The Sales picker is at `:340-352`.
- **Reducer** (`cashier/state/cashierReducer.ts`).
  - `paymentMethod` and `amountPaid: string` (`:63-64`, initial `:132-133`).
  - Actions: `OPEN_CHECKOUT {defaultMethod}` resets the amount (`:557-563`); `SET_PAYMENT_METHOD` and `SET_AMOUNT_PAID` (`:568-572`).
  - There is no tender list and no change field (change is derived).
- **Payload.**
  - `CashierScreen.tsx:357-359` derives `defaultMethod` and the tender.
  - `engine.enqueue('order', {orderNumber, items, paymentMethod: state.paymentMethod, amountPaid: tender.amountPaid, …})` (`:768-772`).
  - There is no top-level `change`. Change lives only in `receiptSnapshot` (`receiptQuote.ts:49-50, 96-97`).
  - `idempotencyKey = deviceId:orderUuid` (`packages/sync/src/engine.ts:883`, enqueue `:899-907`).
  - The payload type is an untyped `Record<string, unknown>` (`packages/sync/src/outbox.ts:33`), so a new key changes no guarded type.

### 1.2 Server sale path
- **Decode.**
  - Sync `case "order"` (`sync.go:313-316`) maps `PaymentMethod`/`AmountPaid` (`:341-342`) with `Offline: true` (`:361`).
  - The direct `POST /orders` (`handlers/orders.go:20-29` body, `:76-88` mapping) uses `Offline: false`, and `ErrTenderRejected` maps to 422 there (`:112-115`).
- **Validation.**
  - `ValidateSaleInput` (`service/order_input.go:90`) applies `saleMoney` to `amountPaid`: finite, ≥0, ≤ numeric(14,2) (`:44-49, :93-100`).
  - The method only has to be non-blank (`:110-113`); it is not checked against the configured methods.
- **Tender rules (A09 slice 8/8c)** (`service/tender.go:30-49`).
  - Comparison is in cents with a Rp1 tolerance (`:14`).
  - Cash: change = captured − due, or `cash_short`.
  - Non-cash: `noncash_amount_mismatch` when off by more than Rp1.
  - The amount stored is always the captured amount.
  - Called at `order.go:449` against `finalTotal = res.Total − redeemAmount` (`:440-445`), so points are not a tender.
  - Only an online `cash_short` rejects (`:450-452`); everything else is flagged (`tender_warning`, `:453`).
- **Storage.**
  - INSERT `orders(…, total, payment_method, amount_paid, change, …, tender_warning, tender_warning_reason, …)` (`order.go:576-598`).
  - Columns come from `0001_init.sql:245-247`. The method CHECK was dropped in `0005_payment_method_freeform.sql:8`; the flags come from `0046_order_tender_warning.sql:4-5`.
  - No endpoint edits payment fields afterwards. The only `UPDATE orders` statements are the refund status writes (`refund.go:302, :308`).
- **Idempotency.**
  - Batch items run through `RunWithReceipt`. The fingerprint is the canonical JSON of the **whole payload** (`service/receipts.go:50-62, :83`).
  - The outbox resends stored payloads verbatim (`RUNBOOK.md` rule 2), so queued pre-C6 items keep their fingerprint.
  - New items simply include `tenders`.
- **Read.**
  - `read/orders.go:25` emits `paymentMethod/amountPaid/change`; `:33-36` emits `refunds[]` with each refund's `paymentMethod`.
  - Typed decode into `api.Order` (`read/orders.go:54-75`) strips any key missing from OpenAPI (the 8c gap class).

### 1.3 Refunds (C4a/C4b/C4c)
- **Server.**
  - `RefundLinesTx` locks the order and reads `payment_method` (`refund.go:124-129`).
  - The D-49 cap is in `refund_input.go:157-180` (amount of record ≤ `orders.total − Σ earlier`).
  - It inserts `order_refunds(…, payment_method = o.paymentMethod, …)` (`:254-260`); the column is NOT NULL, commented "= orders.payment_method (no re-tender)" (`0077_order_refunds.sql:20`).
  - The catch-up trigger `orders_refunded_legacy_row` copies `NEW.payment_method` (`0077:109-133`).
- **POS.**
  - `prepareRefund` puts the sale's method in the display snapshot (`refundView.ts:126, 134, 166`).
  - The dialog says "Dibayar lewat {method}" (`RefundDialog.tsx:124, 174-179`).
  - The queued-refund recap keys on `payload.paymentMethod` (`refundRecap.ts:62-67`).
- **Already per refund row (good for C6):**
  - shift `refunds_paid_by_method` / `cash_refunds_paid` (`shift.go:211-224`, live for open shifts `read/shifts.go:24-29, 57-89`);
  - report `refundsByPaymentMethod` (`reports.go:69-71`);
  - the refund report (`read/refund_report.go:31`);
  - backoffice `refundReport.ts:75` and `OrderRefundSection.tsx:32`.

### 1.4 Every reader that sums, groups or filters by method (must change)
| # | Reader | Today | Slice |
|---|---|---|---|
| R1 | Shift close buckets | `sum(net_sale) FILTER (payment_method …)` per order, `net_sale = total − refunded` (`service/shift.go:171-209`; cash `:196`, qris `:199`) | C6a |
| R2 | Shift cash ids | `orders.payment_method UNION order_refunds.payment_method` (`shift.go:239-262`) | C6a |
| R3 | Report by method, net and gross | `sb` CTE carries `o.payment_method` (`read/reports.go:40`); `pay` (`:59-63`) and `gpay` (`:65-67`) group per order | C6a |
| R4 | Order filter, shared by the order list and the report summary | `lower(btrim(o.payment_method)) = …` (`read/orderfilter.go:62, 120-121`, handler `order_filter.go:63, 87`; summary `read/reports.go:35, 37`) | C6a: two rules (list = EXISTS on tender lines; summary = money limited to the method, D-66; `split` = the order column) |
| R5 | Order read | one method + `amountPaid`/`change` (`read/orders.go:25`) | C6a (+ `tenders[]`) |
| R6 | Customer profile | `o.payment_method, o.total` per order (`read/customer_profile.go:144, 157`) | C6a (+ tender label) |
| R7 | ERP sale/refund tender | `orderSQL` single method (`erp/payload.go:263`), `buildTenders` one element (`:216-236`), refund uses the **order** method (`:227`) | C6a |
| R8 | Refund method | copy of the sale method (`refund.go:124-129, 254-260`; trigger `0077:117-121`) | C6a |
| R9 | Backoffice report oracle | gross and refunds keyed by order method (`reportTotals.ts:104-111, 106, 120`) | C6a (fallback) |
| R10 | Backoffice dashboard | `paymentBreakdown` per order method (`screens/dashboard/metrics.ts:402-404`; `Dashboard.tsx:150`) | C6a (fallback) |
| R11 | POS shift recap | `byMethod[o.paymentMethod] += kept` (`cashier/recapAggregate.ts:43-44`); `ShiftRecapPanel.tsx:147-156, 372-374, 497-533` | C6b |
| R12 | POS queued-refund recap | `payload.paymentMethod` (`refundRecap.ts:62-67`) | C6b (`payoutMethod`) |
| R13 | Backoffice orders list/detail/CSV | `Orders.tsx:90` (CSV), `:206` (label), `:285` (Kembalian), filter `orderQuery.ts:21`, options `lib/paymentOptions.ts:13-25` | C6c |
| R14 | Backoffice refund CSV | `ExportTab.tsx:63` uses the **order** method (pre-existing mismatch) | C6c (switch to `r.paymentMethod`) |
| R15 | Backoffice customer detail | `CustomerDetailSections.tsx:181-185` | C6c |
| R16 | POS displays | `OrderHistoryPanel`, `LocalReceiptsPanel`, `localReceipts.ts:52, 84`, `customerProfile.ts:100, 118`, `ReceiptPreview.tsx:30-32, 165-171` | C6b |
| R17 | Receipt print | one row `paymentLabel  amountPaid` + Kembalian (`packages/printer/src/escpos.ts:233-235`) | C6b |

**Unaffected (verified):**
- `exportSummary.ts:62-70` renders the server maps, so it follows R3.
- `ShiftsTab.tsx:45-50, 117-119` and the printed shift recap (`escpos.ts:259-282, 328-340`) render stored or POS-built rows.
- The refund report, `OrderRefundSection` and `refunds_paid_by_method` are already per refund row.
- `customers.total_spent`, points and the D-49 cap all use `total`.
- No promo, loyalty or pricing rule reads the payment method in Go or TS. The only non-test files touching the method are the readers above, plus `backend/internal/fsmigrate/tables.go` (Firestore import; it writes orders without tender rows, which the synthetic rule covers).

### 1.5 ERP side (erp-flamboyan 69ababa8, read-only, pulled clean)
- **Contract.** `tenders` is an array with no item limits; the method enum is `cash/card/transfer/qris` and the amount is an integer, negative on a refund (`docs/integration/stock-documents.v1.yaml:217-221, 343-352`; serah-terima `:176`, Q7 `:324`, Q16 `:402`).
- **ERP ingest.** `TenderSchema = {method: text ≤30, amount: int}`; the array is optional with **max 20** (`packages/shared/src/integration/stock-document/stock-document.schema.ts:58-61, 89`).
  - The method is free text in the Zod schema, which governs over the enum in the ERP's `api.md`.
  - There is no Σ = total check, no per-method uniqueness and no refund-method match.
  - Tenders are stored as a JSON column (`prisma/schema.prisma:1894`) and described as information only (ERP `docs/modules/integration/stock-document/README.md:82`). This matches owner E-2 (2026-10-28).
- **Result.** Several tender lines per sale document are accepted as they are. No ERP change and no new ERP question is needed. Only the doc text should say "satu baris per metode bayar".
- **One gap.** Only single-tender fixtures exist on the ERP side. A multi-tender relay is covered by our own `erp_e2e` test plus the stub.

---

## 2. Design

### 2.1 Data: migration `0079_order_tenders.sql`
```sql
CREATE TABLE order_tenders (
  order_id   uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  seq        smallint NOT NULL CHECK (seq BETWEEN 1 AND 8),     -- wire max is 4 (D-51); headroom only
  method     text NOT NULL CHECK (btrim(method) <> '' AND lower(btrim(method)) <> 'split'),
  amount     numeric(14,2) NOT NULL CHECK (amount >= 0),          -- applied to the bill; Σ per order = orders.total
  tendered   numeric(14,2) NOT NULL CHECK (tendered >= 0),        -- captured: cash handed over / amount charged
  change     numeric(14,2) NOT NULL DEFAULT 0 CHECK (change >= 0),-- cash line only
  reference  text CHECK (reference IS NULL OR char_length(reference) <= 64),
  PRIMARY KEY (order_id, seq)
);
ALTER TABLE order_refunds ADD COLUMN IF NOT EXISTS payout_source text
  CHECK (payout_source IS NULL OR payout_source IN ('sale','chosen','default'));  -- NULL = written before C6a
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS split_tender_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS split_tender_enabled_at timestamptz;  -- set the first time it is switched on, never cleared (rollback guard, 2.5)
-- + order_default_payout_method(uuid) and CREATE OR REPLACE orders_refunded_legacy_row() (2.6)
```
- **Settings write.** `splitTenderEnabled` is a `*bool` in `UpdateAppSettingsBy` (`write/settings.go:44-88`), where absent leaves the stored value. This is the `InventoryApprovalRequired` pattern (`:58-60`).
  - A plain `bool` would let every save from a form that does not know the key (the pre-C6c backoffice, which deploys on its own) silently switch split payment off.
  - Switching it on also sets `split_tender_enabled_at` if it is NULL.
- **Why no backfill and no catch-up trigger.**
  - C4a could write its refund row before flipping `orders.status`. A tender row needs the order row first (FK), so an `AFTER INSERT ON orders` trigger would fire before the new code inserts its own rows and create duplicates.
  - The old revision keeps writing tenderless orders on the migrated DB until promotion (and after any rollback).
  - The **synthetic-line rule** below handles all of these with no race. A one-off backfill is optional and not recommended: it would only duplicate the rule.
- **Synthetic-line rule (one shared fragment, Go const `tenderLinesLateral`, used by R1-R7):**
  ```sql
  CROSS JOIN LATERAL (
    SELECT t.seq, t.method, t.amount, t.tendered, t.change, t.reference, false AS synthetic
      FROM order_tenders t WHERE t.order_id = o.id
    UNION ALL
    SELECT 1, o.payment_method, o.total, o.amount_paid, o.change, NULL, true
     WHERE NOT EXISTS (SELECT 1 FROM order_tenders t2 WHERE t2.order_id = o.id)
  ) tl
  ```
  - It uses the PK index per order. C6a checks `EXPLAIN` on the Neon-sized data for reports and shift close (risk 9).
  - The synthetic row reproduces exactly how every reader treats a pre-C6 order today: the whole `total` under `payment_method`.
- **C6a writes rows for every new sale** (one row for a single tender), so synthetic rows only ever mean "written without C6a".
- **`orders.payment_method` on new orders:** the shared method when every line has the same method (e.g. two `card` lines), otherwise `split`.
  - `amount_paid = Σ tendered`; `change = the cash line's change`.
  - So `amount_paid − change = total` still holds for a fully paid sale, and pre-C6 readers of these columns stay meaningful.
- **Reserved id.** `validatePaymentMethods` (`write/settings.go:18-30`) rejects a configured method with id `split` (case-insensitive) with a 400 and a clear message. The DB CHECK above backs it.

### 2.2 Wire format
**Sale payload** (sync `order` and direct `CreateOrderRequest`, additive):
```json
{ "paymentMethod": "split", "amountPaid": 1351000,
  "tenders": [ { "method": "qris",  "amount": 751000, "reference": "8812345" },
               { "method": "tunai", "amount": 600000 } ] }
```
- `amount` is what the line captured: the cash handed over for the cash line, or the amount charged for a non-cash line.
- **The server ignores the scalar summary when `tenders` is present and non-empty.**
  - The POS fills the scalars anyway (`paymentMethod` = the shared method or `split`; `amountPaid` = Σ amount) so that older local views and an old server degrade visibly.
  - The POS also writes the lines into `receiptSnapshot.tenders` (opaque to the server, `service/quote.go:24-45`). A sale that reached an old server therefore usually keeps its split in `orders.receipt_snapshot`, and a repair script can rebuild `order_tenders` from it (RUNBOOK, section 4).
  - This repair is **best effort only.** The snapshot is stored only with a valid quote of at most 64 KB (`service/quote.go:15, 29-36`; `order.go:458-462`).
- **No `tenders` key** (2.4.0 bundles, APK builtin, direct callers) takes the legacy path unchanged: `evaluateTender` as today, plus one `order_tenders` row (`amount = finalTotal`, `tendered = amountPaid`, `change`).
  - One addition: a scalar `paymentMethod` of `split` (case-insensitive) without `tenders` is a structural reject in `ValidateSaleInput`.
  - Without that it would pass the non-blank check (`order_input.go:110-113`) and then hit the `order_tenders` CHECK inside the transaction: a 500, which on the batch route means an endless retry.
- **One tender line** goes through `evaluateTender` **only**, without the multi-line structural rules: a non-cash 0 is still stored and flagged (owner 8c Q3).
  - So the new POS's single-method sale is byte-identical to the legacy one: same flags, same `amount_paid`/`change`, same TD gate outcomes.
  - In split mode the POS turns a blank cash input into "Sisa" (today a blank cash input means "exact", `tender.ts:15`), so the POS never sends a zero line.
- `tenders: []`, `null` or a non-array is a structural reject (2.3).
- **Σ tendered** (which becomes `orders.amount_paid`) must pass `saleMoney` as well as each line (`order_input.go:44-49`). Otherwise four maximal lines would overflow `numeric(14,2)` inside the transaction.

**Order response** (additive; `read/orders.go` via the synthetic rule, so every order has ≥1 line, old ones included):
```json
"paymentMethod":"split","amountPaid":1351000,"change":100000,
"tenders":[{"seq":1,"method":"qris","amount":751000,"tendered":751000,"change":0,"reference":"8812345","synthetic":false},
           {"seq":2,"method":"tunai","amount":500000,"tendered":600000,"change":100000,"reference":null,"synthetic":false}]
```
- **Refund payload** (sync `refund` and `RefundRequest`): an optional new key `payoutMethod`.
  - It is server-read, unlike the display-only `paymentMethod` snapshot (`refundView.ts:126`). That old key stays and is still ignored.
  - `refunds[]` in the Order gains `payoutSource`.
- **Settings:** `AppSettings.splitTenderEnabled` (optional; absent = false, so an old server reads as off).
- **OpenAPI** (gap class: each new key needs a schema, the `json_build_object` key, regen, `gen:check` and a Postgres round-trip test):
  - `OrderTender`, `Order.tenders`, `Order.refunds[].payoutSource`;
  - `CreateOrderRequest.tenders` (`openapi.yaml:2136-2152`);
  - `RefundRequest.payoutMethod` (`:2175-2189`);
  - `AppSettings.splitTenderEnabled` (`:1955-1967`);
  - a documented `SyncOrderPayload` / tender item under `SyncBatchItem` (`:2332-2338`; today only the refund payload is documented, `:2192`).
  - Use `undefined` rather than `null` for cleared optional fields in TS (memory `openapi-nullable-ref-codegen-gotcha`).

### 2.3 Invariants and where each is enforced
Comparisons are in whole cents with the Rp1 tolerance (`tender.go:14`). `due = finalTotal` (after points; points and rounding are not tenders, `order.go:440-445`). `N = 4` (D-51).

| Invariant | POS UI (C6b) | TS twin `cashier/tenderSplit.ts` | Server `service/tender_split.go` (authoritative) |
|---|---|---|---|
| 1 ≤ lines ≤ N | "+ Tambah pembayaran" hidden at N | rejects | structural reject (D-54) |
| No negative/non-finite/oversize line (both shapes); no zero line **when there are two or more lines** | amount ≥ Rp1 to add a line | rejects | structural reject (`saleMoney` per line, `order_input.go:44-49`). A **single** line keeps the legacy rule: a non-cash 0 is stored and flagged (owner 8c Q3), so one-line parity holds |
| Method non-blank, ≤ 64, not `split` | chips from config only | rejects | structural reject |
| At most one cash line | a second cash entry is **added into** the existing cash line | rejects two | **online: structural reject. Batch: merge the cash lines (Σ tendered, first line's method and `seq`) and flag `tender_cash_merged`.** Cash identity follows the current `isCash` setting (`rules/payment_method.go:13-28`), so an offline sale replayed after an admin changed a method's flag must not be sent to review after the money was taken |
| Change only from cash: Σ non-cash ≤ due | non-cash amount capped at "Sisa" | flags | flag `noncash_overpay` (both routes, as slice 8 Q5 "non-cash mismatch: flag only") |
| Σ captured ≥ due (no shortfall) | Konfirmasi disabled until Sisa = 0 | flags | **online: 422 `ErrTenderRejected`; batch: accept + flag `tender_short`** (as `cash_short`, owner slice 8 Q1) |
| Reference ≤ 64 printable runes | `maxLength` | rejects | structural reject |
| No scalar `split` without `tenders`; Σ tendered ≤ the money cap | n/a | n/a | structural reject (2.2) |
| Σ applied = `orders.total` | n/a | same allocation | allocation (below); invariant query in the gate and RUNBOOK |

**Deliberate difference on the direct route.**
- Online, any shortfall on a two-or-more-line sale is rejected, even with no cash line.
- A single non-cash line that is short stays flag-only (slice 8 Q5).
- The reason: the POS cannot produce a short split (Konfirmasi needs Sisa = 0), and the direct route serves tests and hand-made calls only (slice 8 §0.1). The batch route always accepts and flags.

**"No zero line" applies to captured amounts.**
- An *applied* amount can be 0: the cash line under `noncash_overpay`.
- `amount_paid − change = total` holds only for unflagged orders.

**Allocation (`allocateTenders`, two or more lines; one line uses `evaluateTender` unchanged):**
1. Non-cash lines: `amount = tendered`, `change = 0`.
2. Cash line, if present: `amount = max(0, due − Σnoncash)`; `change = max(0, cashTendered − amount)`. A cash shortfall leaves `amount` at its full share. That is exactly today's `cash_short` treatment: readers count the full total, and the flag explains the drawer gap.
3. If the lines still do not sum to `due` (no cash line and Σ non-cash ≠ due, or non-cash over the due): the difference is put on the **last** line, and an excess is taken off lines from the last backwards, never below 0. The order is flagged (`tender_short` / `noncash_overpay`). `tendered` always stays verbatim. (D-55.)
4. Flag priority when several apply: `tender_short` > `noncash_overpay` (one reason column, `0046`).

**Placement.** The same as slice 8: after the replay guard (`order.go:248-256`), validated in `ValidateSaleInput` for structure, and judged after `finalTotal` (`order.go:449`) and before stock. Known receipts are never re-judged.

**Golden vectors.** `backend/internal/service/testdata/tender_golden.json` is shared by the Go tests and the TS twin (the `allocate_golden.json` pattern from C4a). Cases:
- cash only, exact / over / short / blank;
- QRIS + cash with change;
- card + card;
- non-cash over;
- due 0;
- points redemption drift;
- rounding on;
- 4 lines;
- each structural reject;
- a single non-cash line of 0 (accepted, flagged);
- a blank cash input in split mode (becomes Sisa);
- two cash lines on batch (merged, flagged);
- QRIS 1,300,000 + cash 100,000 with due 1,251,000. Result: `noncash_overpay`, cash applied 0 with change 100,000, QRIS applied 1,251,000 with tendered 1,300,000. The printed change must come from the same allocation.

### 2.4 Readers (C6a server; formulas)
For a set of sale orders and a method `m`:
`sales_m = Σ tl.amount[m] − Σ order_refunds.amount of those orders with payment_method = m`.
- **Equivalence.** For every pre-C6 order there is one synthetic line `(payment_method, total)`, and every refund row's method equals the order's method (`refund.go:254-260`). So `sales_m` equals today's `Σ (total − refunded)` grouped by order method. Byte-identical; the gate proves it on fixtures.
- **R1 shift close (`shift.go:171-232`): two subqueries, never one.**
  - **(a) The per-order block stays exactly as it is** (`:189-209`, one row per order): `total_sales = sum(net_sale)`, `total_orders = count(*) FILTER is_sale`, `total_refunds = sum(refunded)`. `net_sale` stays NULL for cancelled orders.
  - **(b) A new per-line block** supplies only `cash_sales` and the card/transfer/qris buckets:
    - per (order, method) = Σ `tl.amount` − Σ refunds of that order paid out in that method;
    - restricted to `o.shift_id = $1 AND o.status IN ('completed','partially_refunded','refunded')`.
  - Joining the tender lateral into block (a) would count a 2-line order twice in `total_orders`/`total_refunds`, and dropping the status filter would count cancelled orders through their synthetic line.
  - For every pre-C6 order (one line) both mistakes are invisible, which is why gate subtest 7 must use a split order and a cancelled split order.
  - The cross-shift refund block (`:211-224`) is unchanged; it is already per refund row.
- **R2 cash ids (`shift.go:239-262`).** UNION in the tender-line methods, so a cash line inside a `split` order is recognised as cash.
- **R3 reports (`reports.go:38-71`).** `pay` and `gpay` read tender lines; `rpay` is unchanged.
  - Net by method can go negative for a method, e.g. a QRIS sale refunded in cash shows negative net cash. That is truthful and only possible on split orders under D-56.
  - **The `pay` filter moves to the per-method row.** Today it is per order: `status IN ('completed','partially_refunded') OR net_total <> 0` (`reports.go:62`).
  - It becomes "sale status OR the per-(order, method) net ≠ 0". Otherwise a fully refunded split order (QRIS 751k + cash 500k, all paid back in cash) would hide its +751k QRIS / −751k cash rows, because its order net is 0.
  - For pre-C6 orders the two filters select the same rows (one line, net equal to the order net).
- **R4 filter: `appendOrderWhere` is shared** by the order list and both row sets of `ReportSummary` (`read/orderfilter.go:62, 120-121`; `read/reports.go:35, 37`). One rule cannot serve both, so C6a splits it with a flag.
  - **Order list / CSV:** `EXISTS (tender line with lower(btrim(method)) = …)`. "QRIS" lists every order with a QRIS line, split orders included. A `split` filter value ("Campuran") lists split orders.
  - **Report summary with a method filter (D-66):** the money is limited to that method.
    - Sales = the filtered method's tender lines.
    - Refunds = refund rows **paid out** in that method (the refund set is filtered on `order_refunds.payment_method`, not on the order).
    - Order count = orders with a line in that method.
    - Otherwise a QRIS-filtered report would show the cash half of every split order as QRIS sales.
  - **What a method filter does to each field `ReportSummary` emits** (`read/reports.go:117-127`):

    | Field | Under the D-66 rule |
    |---|---|
    | `totalSales`, `grossSales` | that method's lines (net / gross) |
    | `totalOrders`, `grossOrders` | orders with a line in that method |
    | `totalRefunds`, `refundedOrders` | refund rows paid out in that method |
    | `netSales`, `avgOrderValue` | derived from the limited figures |
    | the three by-method maps | only the filtered key |
    | `dailySales[]` | the same limiting in both `sd` and `rd` (`:91-104`), so the documented invariant Σ daily `netSales` = `netSales` (`:30-31`) still holds |
    | `topProducts` (`:73-89`) | **cannot be limited**: sale lines are not allocated across payments. It lists the products of orders with a line in that method at full line revenue, so its total can exceed the limited `totalSales`. The UI labels it "produk dari transaksi yang memakai metode ini" |

  - **The `split` filter value ("Campuran")** is a special case on both rules: `o.payment_method = 'split'`, whole-order money. Tender lines are never `split`, so EXISTS would match nothing.
  - **The client oracle must apply the same rule.** `reportTotals.ts` sums the filtered order list, and so does any parity check (e.g. `scripts/a31-browser/reports-races.js`). C6a updates `reportTotals.ts` to limit by `o.tenders` and `o.refunds[].paymentMethod` under a method filter, or the oracle and the server disagree.
  - For pre-C6 orders both rules select the same rows as today, so every field is unchanged.
- **R5 / R6.**
  - `read/orders.go` adds `'tenders'` (a `json_agg` over the lateral, ordered by `seq`) and `refunds[].payoutSource`.
  - The customer profile adds `tenders` (or the label) per order.
- **R7 ERP** (`erp/payload.go`).
  - `orderSQL` loads the tender lines via the lateral.
  - `buildTenders` emits one `Tender` per line with `amount > 0`, rounded to whole rupiah, the last line taking the rounding remainder so that Σ = `round(total)`. Part 1 only, as today (`:217`).
  - The method is mapped by `erpTenderMethod(id)`: cash-identified → `cash`; `card/transfer/qris` as is (case-insensitive; today's match at `:40, :217` is case-sensitive); others omitted (D-61). This fixes `tunai`.
  - `buildTenders` is pure today, so the cash identity needs the payment-method settings loaded in `LoadBuildInput`. They are passed in, never read inside the builder.
  - The refund tender uses `order_refunds.payment_method`, loaded with `refundAmountSQL` (`:264-270`), instead of the order method (`:227`).
  - The existing `OrderInfo` literal tests (`erp/payload_test.go:76, 105, 181`) keep working through a fallback: no tender lines means one line `(PaymentMethod, Total)`.
  - Documents already built keep their frozen payload (`erp/admin.go:63-70`), so a re-send is unchanged. Only documents built after the deploy carry the new tenders.
- **R9 / R10 backoffice (ships with C6a).**
  - Gross by method sums `o.tenders` when present, otherwise `[{o.paymentMethod, o.total}]`.
  - Refunds by method sum `o.refunds[].paymentMethod` when present, otherwise the order method. This also fixes `reportTotals.ts:120`.
  - The dashboard `paymentBreakdown` (`metrics.ts:402-404`) does the same.
  - Because of the fallback the backoffice may deploy before the backend (Cloudflare deploys on push).

### 2.5 Back-compat and old orders in every reader
- **Old orders.** The synthetic line makes them identical everywhere: server readers, `Order.tenders` and the ERP. Clients still accept a server without `tenders` and fall back to the scalars.
- **Old bundles (2.4.0 OTA, APK builtin) seeing a `split` order** (only possible after the owner enables the setting):
  - the label falls back to the raw id `split` (`lib/paymentLabels.ts:7-9`);
  - their shift recap puts the whole order in a `split` bucket that no method row shows, so its cash is missing from that tablet's local recap (`recapAggregate.ts:43`);
  - a refund from them carries no `payoutMethod`, so the server default applies (D-58).
  - **Hence:** enable the setting only when every active tablet reports ≥ the C6b version in `/ota/check` logs (RUNBOOK OTA rule 5 explains how to join them).
- **Bundle rollback (C6b → 2.4.0) with a split sale still queued.** The old bundle resends the payload verbatim (RUNBOOK rule 2), so the server stores the split correctly. Its local views use the scalars (`split`, Σ tendered), and its reprint shows `split` with the right total and change. Accepted.
- **Backend rollback below C6a after a split exists:**
  - queued splits would be flattened to `split` + `amount_paid`;
  - shift and report readers would group a `split` bucket (cash missing from the drawer);
  - refunds of split orders would record `split`.
  - **Rule: no backend rollback below C6a once `app_settings.split_tender_enabled_at IS NOT NULL`; fix forward.**
    - The order count alone is not a safe guard: an offline tablet with the cached setting can hold queued splits the server has not seen yet.
    - If a rollback is unavoidable anyway:
      1. switch the setting off;
      2. wait until every tablet has pulled the change;
      3. confirm zero pending sales on every tablet;
      4. confirm `SELECT count(*) FROM orders WHERE payment_method = 'split'` and `… order_refunds WHERE payout_source = 'chosen'` are known and accepted;
      5. then roll back.
  - Until the owner first enables the setting, no split can exist, so C6a stays freely rollback-able during its soak.
- **Kill switch.** Turning `splitTenderEnabled` off hides split payment on the next settings pull. It does **not** make the server refuse split payloads: sales captured while it was on and still queued must be accepted.
  - A settings save bumps the content version through the write helper (`write/repo.go:59-68`), so tablets pull the change.
- **Tablets cache the setting.** `appSettings` arrives in the pull bundle (`openapi.yaml:2321`) and is read from the cached snapshot (`CashierScreen.tsx:270, 292`). A tablet re-pulls only when the content version changes (`sync/pull.go:29-53`).
  - So a backend rollback alone leaves tablets offering split payment against an old server.
  - **Emergency rollback after enabling:** turn the setting off first; wait until the tablets have pulled (or bump `content_versions` by SQL) and their queues are empty; then roll back.
  - The no-rollback rule above still applies once a split order exists.

### 2.6 Refund payout on split orders
- **Single-method orders** (every line has the same method, which includes all pre-C6 orders): `payout = orders.payment_method`, `payout_source = 'sale'`. Any `payoutMethod` sent is ignored. This is today's rule (D-56 alternative: honour it everywhere).
- **Split orders:**
  - **With `payoutMethod`** (non-blank, ≤ 64, not `split`): use it, `payout_source = 'chosen'`. Any method is accepted; the POS offers only the sale's methods plus cash (D-57).
  - **Without it** (2.4.0, builtin, an old backoffice form): use the default, `payout_source = 'default'`. The default is the cash line's method if the sale had a cash line, otherwise the line with the largest applied amount (ties: lowest `seq`).
- **One payout method per refund row.** Paying one refund back in two methods means two partial refunds.
- **No per-method cap** (D-57); the D-49 order cap is unchanged.
- **Legacy writers.** C6a adds `order_default_payout_method(order_id uuid) RETURNS text` (SQL, the same rule) and replaces `orders_refunded_legacy_row()` (`0077:109-133`) so that a raw `status='refunded'` write on a split order records the default method, not `split`. Go and SQL must agree, which the gate parity case checks.
  - The SQL must reproduce `IsCashMethod` (`rules/payment_method.go:13-28`) over `app_settings.payment_methods` (jsonb):
    - a configured entry whose id matches case-insensitively and has an explicit `isCash` wins (an explicit `false` makes even `cash`/`tunai` non-cash);
    - otherwise `lower(id) IN ('cash','tunai')`.
  - Both Go and SQL judge with the settings in force at refund time.
- **Refund idempotency.** Each refund enqueue mints a fresh key (`CashierScreen.tsx:939`, `engine.enqueue` default uuid), and a queued refund blocks the order (D-44). So a payout chip can only change before the payload exists; there is no fingerprint conflict.
- **Shift and drawer** need no new logic. `cash_refunds_paid`, `refunds_paid_by_method` and R1's refund subtraction all read `order_refunds.payment_method`, which is now the payout.

### 2.7 POS UX: W2 gains a split mode (C6b)
- **Entry.** Under the method chips there is a text button **"Bagi pembayaran"**. It is shown only when `settings.splitTenderEnabled === true` and at least 2 methods are enabled.
- **Single mode is unchanged** (A3/W2), apart from the optional "No. referensi" under non-cash methods (D-59).
- **Model** (Shopify/Loyverse: choose the type, then the amount):
```
┌───────────────────────────────────────────────┐
│ ‹ Kembali        Bayar Rp 1.251.000            │
│ [ Tunai ] [ Kartu ] [ QRIS ✓ ] [ Transfer ]    │ 56 dp chips
│ Jumlah QRIS  [ Rp 751.000          ] (Sisa)    │ non-cash: capped at Sisa; "Sisa" chip fills it
│ No. referensi (opsional) [ 8812345 ]           │ D-59
│ [ + Tambah pembayaran ]                         │ disabled at N lines or amount < Rp1
│ ─ Pembayaran ─────────────────────────────────│
│ QRIS · Ref 8812345           Rp 751.000   [×]  │ × asks "Sudah dibatalkan di mesin?" (D-63)
│ Sisa tagihan                 Rp 500.000        │ amber until 0, then "Lunas" green
│ (Tunai ✓) Diterima [Rp 600.000]                │ cash: D-3 chips computed from Sisa
│ (Uang Pas)(550.000)(600.000)(1.000.000)        │
│ Kembalian                    Rp 100.000        │ only from the cash line
│ ┏ KONFIRMASI Rp 1.251.000 ┓  (enabled when Sisa = 0) │
└───────────────────────────────────────────────┘
```
- **Behaviour rules:**
  - Cash with an amount ≥ Sisa closes the bill and shows Kembalian; cash < Sisa adds a part-cash line.
  - A second cash entry is added into the existing cash line.
  - Once Sisa = 0, only removal is possible; "+ Tambah" is hidden.
  - Konfirmasi shows the order total, not the amount tendered.
- **Total changes while lines exist** (points or a reward in the "Hadiah & Poin" block; a promo dropped by the B2 confirm guard `cashier/confirmGuard.ts`):
  - lines are kept and Sisa is recomputed;
  - if Σ non-cash > new total, Konfirmasi is blocked with "Total berubah, hapus pembayaran {method} lalu masukkan lagi";
  - the confirm handler re-runs `planSaleTender` against `derived.total` at tap time and refuses a stale plan, never trims it (the C4b `planRefundSubmit` rule).
- **Leaving.** "‹ Kembali" with lines asks "Hapus pembayaran yang sudah dimasukkan? Pastikan transaksi di mesin EDC/QRIS dibatalkan." (D-63).
- **Success view and receipt.** One row per line ("QRIS · Ref 8812345 Rp 751.000", "Tunai Rp 600.000"), then Kembalian.
- **Riwayat / local receipts:**
  - the method cell reads "Campuran" (D-60) with the lines on expand;
  - the refund dialog (W4) adds "Dibayar QRIS Rp 751.000 + Tunai Rp 500.000" and, for split orders only, payout chips "Dikembalikan lewat (Tunai ✓)(QRIS)" with the D-56 default preselected.
- **Checkout draft (D-62).** Android may kill the POS while the cashier is in an EDC/e-wallet app (HANDOFF C5 note), and the cart is in memory. With split payment the first non-cash line is charged **before** the sale exists.
  - When the first non-cash line is added, C6b saves a draft (cart lines + tender lines + total) through the held-orders store (`cashier/heldOrders.ts`, app KV, not journal-guarded), named "Pembayaran terpisah belum selesai".
  - **The draft must never become a second sale.** Today the order uuid is minted inside `engine.enqueue` (`CashierScreen.tsx:768`; `packages/sync/src/engine.ts:899-903`), and an app kill between the outbox write and a later draft delete would leave a draft for a sale that is already queued. So:
    1. The draft mints the sale's `orderUuid` when it is created. Confirm passes that uuid to `engine.enqueue(type, payload, orderUuid)`, so the idempotency key `deviceId:orderUuid` is fixed from the first charge.
    2. The draft is deleted inside the `saleGate` run, right after the enqueue resolves.
    3. On start, any draft whose uuid is already in the outbox or the receipt archive is dropped without a prompt.
    4. Should a duplicate still slip through, the same key makes the server return the existing order (replay), not a second sale.
  - It is also deleted on an explicit cancel.
  - On the next start, a banner "Ada pembayaran terpisah belum selesai: QRIS Rp 751.000 sudah dicatat" leads to restore, which reuses the B4 `heldRestore.ts` planner, then reopens W2 with the lines.
- **Reducer.**
  - New state `splitMode: boolean` and `tenders: TenderLine[]` (`{method, amount, reference?}`).
  - New actions `SPLIT_START`, `TENDER_ADD`, `TENDER_REMOVE {index}`, `SPLIT_CANCEL`.
  - These are cleared by `OPEN_CHECKOUT`, `CLOSE_CHECKOUT` (after the confirm), `RESET_SALE` and `ORDER_SUCCESS`.
  - Held orders (B4) never store tender lines except as the D-62 draft (D-64).

### 2.8 Receipt (C1 "struk = layar")
- `ReceiptSnapshot` gains an optional `tenders?: {method, label, amount, reference?}[]` (`receiptQuote.ts:49-50`, built at `:81, :96-97`, read at `:160-161`). It stays v2, with **no v3 bump**, which would repeat the C1 rollback cost (RUNBOOK "Receipts and C1"). `amountPaid` = Σ tendered and `change` = the cash change, as today.
- `ReceiptData` (`packages/printer/src/escpos.ts` type) gains an optional `tenders?`. When present, `escpos.ts:233` prints one row per line (`label  amount`, with a second line "Ref 8812345" when given) instead of the single row. Kembalian (`:234-235`) is unchanged.
- `ReceiptPreview.tsx:165-171` and `receiptRows.ts:56-58` render the same rows (the C1 parity test decodes the slip).
- `ReceiptEntry` (`packages/sync/src/receiptArchive.ts:12-34`) gains an optional `tenders?`, copied in `receiptEntryFromItem` (`:66-89`) and the engine copies (`engine.ts:1160, 1178`).
- `localReceipts.ts:43-60` maps them into the synthetic `Order.tenders`; `:84` uses the "Campuran" label.
- **Rollback.** A pre-C6b bundle reprints a split receipt as `split  Rp 1.351.000` plus the correct Kembalian. The label is raw; the money is correct.

### 2.9 Offline behaviour
- A split sale captured offline is queued like any sale: the payload with `tenders` goes into the journal as is (no guarded format change, section 4 C6b).
- On replay the server judges it as an offline sale: accepted and flagged for shortfall or drift; a structural fault goes to review (Rejected).
- The 12 h cap (`sync.go:299-311`), the idempotency key and the fingerprint are unchanged.
- Each queued line is visible in the local receipt and the parked/review views. `reviewLabels.ts` (C6c) adds the tender summary to the payload text.
- The D-62 draft also protects an offline sale between the first non-cash charge and Konfirmasi.

---

## 3. D-register (owner decisions; continues D-1..D-49)

| ID | Question | Recommended default |
|---|---|---|
| D-50 | How is split payment switched on? | **Server setting `splitTenderEnabled`, default off; backoffice toggle in C6c; enable only after the demo and once every active tablet runs the C6b bundle.** Turning it off is the kill switch (UI only; queued splits are still accepted). Alternative: always on once C6b ships (no toggle; no kill switch). |
| D-51 | Maximum payment lines per sale | **4** (cash + QRIS + 2 cards). The ERP allows 20. Alternatives: 3 (simpler screen) or 6. |
| D-52 | Cash lines | **At most one cash line; a second cash entry is added into it; only the cash line gives change.** On the batch route two cash lines (possible after an admin changes a method's "Tunai" flag while a sale is queued) are merged and flagged, never sent to review. Alternative: allow several cash lines, with the change taken from the last one. |
| D-53 | May a non-cash line exceed the remaining amount (overpay on EDC/QRIS)? | **No: the POS caps it at Sisa. The server flags `noncash_overpay` and never rejects** (slice 8 Q5). Alternative: allow it and pay the excess back as cash change (the drawer then pays out money that came in on the EDC). |
| D-54 | A structurally invalid tender list (a negative or non-finite line, a zero line among two or more, more than 4 lines, blank or `split` method, a scalar `split` without lines, Σ over the money cap) | **Reject on both routes (the batch item goes to review), the same as a negative `amountPaid` today (A09-input-numeric).** A correct POS cannot produce one. A single line keeps the legacy rules, and two cash lines are merged on batch (D-52). Alternative: accept and flag. |
| D-55 | Shortfall or drift (server total ≠ what was collected) on a split sale: which method carries the difference? | **Keep Σ applied = order total.** The cash line carries it if there is one (exactly today's `cash_short`: expected cash includes the gap and the flag explains it); otherwise the last line. The captured amount is kept verbatim in `tendered` and the order is flagged. Reports by method then always add up to total sales, as today. On the direct route any split shortfall is a 422; batch always accepts and flags (2.3). Alternative: store applied = captured and show a separate "Selisih pembayaran" row in reports and the shift recap. |
| D-56 | Refund payout method on a split order | **The cashier picks one per refund from the sale's methods plus cash. Default: cash if the sale had cash, else the largest line.** Single-method orders keep today's rule (refund = sale method, no choice). Alternative: allow choosing on every order, so a QRIS sale refunded in cash is recorded as cash. |
| D-57 | Per-method refund cap (e.g. cash refund ≤ cash paid) | **None; only the D-49 order cap.** Stores refund in cash whatever the customer paid with. Alternative: flag `payout_exceeds_tender` as information. |
| D-58 | Refund of a split order from an old bundle, the APK builtin, the old backoffice form or a raw status write (no payout method) | **The server uses the D-56 default (`payout_source='default'`); the 0077 trigger function is replaced to match.** Alternative: refuse such a refund (conflict → review, "Perbarui aplikasi"), which blocks refunds of split orders from un-updated tablets. |
| D-59 | Reference number (D-21) | **Optional "No. referensi" per non-cash line, up to 64 characters, printed on the receipt and shown in the backoffice; never required.** Single-method sales get it too. Alternatives: required for Kartu/EDC (stronger reconciliation, slower checkout), or leave D-21 out of C6. |
| D-60 | Label for a sale paid with several methods | **"Campuran"** (POS lists, backoffice list and CSV, customer profile); detail views show each line. Alternatives: "Terpisah", or list the methods inline ("QRIS + Tunai"). |
| D-61 | ERP tender methods: today only the ids `cash/card/transfer/qris` pass, so **`tunai` (the live cash id) and custom ids send no tender** | **C6a maps every cash-identified id to `cash`, keeps `card/transfer/qris`, and still omits other custom ids.** The owner lists any custom id that should map (e.g. `edc` → `card`). Tenders are information only (E-2), so the risk is low. Alternative: leave the relay filter as it is and fix it in its own slice (cash sales keep sending no tender). |
| D-62 | Keep an unfinished split payment if the app is killed (EDC/QRIS app switch) | **Yes: auto-save a draft when the first non-cash line is added; restore prompt on the next start (B4 held-orders store). The draft fixes the sale's order uuid from the start, so it can never become a second sale (2.7).** Alternative: accept the risk; the cashier re-enters the payment and checks the EDC slip. |
| D-63 | Removing a charged line or leaving checkout with lines | **A confirm that reminds the cashier to cancel it on the EDC/QRIS machine.** Alternative: no confirm (faster, but an EDC charge is easy to forget). |
| D-64 | Held orders (D-6) and payment lines | **Held orders never store payment lines (only the D-62 draft does).** Alternative: keep the lines in a held order (a part-paid order can then be parked, with the risk of forgetting it). |
| D-65 | Release timing | **After the 2 Nov demo**: C6a deploy → 24 h soak → C6b OTA → fleet on C6b → C6c → enable (D-50). The owner may pull C6a forward, since with the setting off it changes no behaviour apart from D-61 and the D-66 filter rule. Alternative: ship C6a before the demo (low risk, but no soak margin before 2 Nov). |
| D-66 | What a payment-method filter means in Laporan (the report summary) once one sale can have several methods | **Money limited to that method: its tender lines as sales, refunds paid out in that method, the count of orders with a line in that method** (field table in 2.4 R4). The order list keeps "orders containing this method", and "Campuran" lists split orders. **Trade-off:** "Produk terlaris" cannot be limited (items are not allocated to payments), so under a filter it shows those orders' products at full revenue and no longer adds up to the limited total; the client oracle needs the same rule. **Alternative (simpler, fully consistent):** keep the summary on the order's single `payment_method`. A QRIS filter then excludes split orders entirely, and their money shows only under "Campuran". |
---

## 4. Slices

Model routing (`AGENTS.md`, memory `model-routing-policy`):
- Opus plans and reviews anything touching sync, payments, migrations or generated types.
- Sonnet implements.
- Haiku does chores and spec checks.

Each slice runs in its own session, worktree and PR, and pushes to `origin` and `ci`: the mirror supplies CI evidence until origin billing unlocks around 1 Nov. The UX plan estimated C6 at 2-3 sessions. With the reader, refund and ERP work found here, it is about **5**: C6a 2, C6b 2, C6c 1.

### C6a: backend + migration 0079 + money readers + ERP + backoffice totals (deploy first)
**Implement: Sonnet 5.5, high effort. Review: Opus 5.5, high** (money, sync, migration, generated types). The owner may ask for the guardian on migration 0079.
- **Files.**
  - **Migration.** `backend/internal/db/migrations/0079_order_tenders.sql`: the table, `payout_source`, the setting column, `order_default_payout_method()`, and the replaced `orders_refunded_legacy_row()`.
  - **Allocation and validation.**
    - `service/tender_split.go` (new): `allocateTenders`, the structural checks, the reason tokens `tender_short` / `noncash_overpay`.
    - `service/tender.go`: unchanged, still used for one line.
    - `service/order_input.go`: structural validation of `Tenders`.
  - **Sale path.**
    - `service/order.go`: `CreateOrderInput.Tenders`; the tender judgement at `:449-453`; INSERT at `:576-598` (summary columns); a new `INSERT INTO order_tenders` in the same tx.
    - `sync/sync.go:575-602`, `:341-342`: `Tenders` on `orderPayload`.
    - `handlers/orders.go:20-29`, `:76-88`: the direct route.
  - **Refund path.**
    - `service/refund.go:124-129`, `:254-260`: the payout rule; `payoutMethod` input (`refund_input.go`, the sync refund case, the direct refund route).
    - `order_refunds.payout_source`.
  - **Readers.**
    - Shared fragment `read/tenderlines.go` (`tenderLinesLateral`).
    - `service/shift.go:171-262`.
    - `read/reports.go:38-71`.
    - `read/orderfilter.go:120-121`.
    - `read/orders.go:21-40` (`tenders`, `refunds[].payoutSource`).
    - `read/customer_profile.go:144-157`.
    - `read/settings.go:18`, `write/settings.go:18-88` (`splitTenderEnabled` as `*bool`, `split_tender_enabled_at`, reserved id `split`).
    - `read/orderfilter.go`: a flag that separates the list rule (EXISTS) from the summary rule (D-66).
  - **ERP.** `integration/erp/payload.go:38-40, 65-72, 216-236, 263-270, 345-349`: tenders from lines, `erpTenderMethod`, refund method from the refund row.
  - **OpenAPI and codegen** (2.2), `make gen-check` and `corepack pnpm gen:check`.
  - **Backoffice money totals** with fallback: `reportTotals.ts:104-120`, `dashboard/metrics.ts:402-404`.
  - **Docs.** ERP doc text (`docs/integration/2026-10-21-serah-terima-erp-pos.md` Q16 and the tender row `:176`: "satu baris per metode; `tunai` dikirim sebagai `cash`"). RUNBOOK: a release/rollback section plus the repair-from-`receipt_snapshot` query.
  - **Ledger guard.** No new stock writer, so `ledger_guard_test.go:163-167` is untouched. Confirm it.
- **Tests.**
  - **Go unit.**
    - `allocateTenders` table and golden file (2.3).
    - Structural rejects.
    - One-line parity: for every golden single-line case, the result equals `evaluateTender` plus a legacy decode.
    - `erpTenderMethod`, and `buildTenders` rounding (Σ = round(total)).
    - Payout default (cash line / largest / tie).
  - **Existing tests that must stay green unchanged:**
    - `service/tender_test.go:8, 43`;
    - `order_input_test.go:333, 355`;
    - `sync/sale_input_test.go:13`;
    - `handlers/sale_input_test.go:19`;
    - `rules/payment_method_test.go:10`;
    - gates TD (`tender_rules_integration_test.go:32`), S0C, RL, RF, QT, ER, GW, OF.
  - **Legacy callers that must keep working unchanged** (they send the old scalar payload):
    - `scripts/smoke/smoke-a44.mjs`;
    - `backend/cmd/erp-rehearsal/steps_sales.go:122` (`paymentMethod: "cash"`; its ERP document now carries a `cash` tender, which is still correct);
    - the browser harness setups `scripts/a24-browser/setup.js`, `scripts/a26-browser/{backoffice-setup,pos-recap}.js`, `scripts/a31-browser/reports-races.js`.
  - **New Postgres gate SP** `TestSplitTenderPostgres`, port **56477** (next free; `scripts/ci/postgres_gate.py:33-70` ends at RL 56476). Subtests:
    1. **sync split sale QRIS + cash with change:** rows, applied Σ = total, `payment_method='split'`, `amount_paid`, `change`;
    2. **online shortfall:** direct split short → 422, zero rows; batch short → accepted, `tender_short`, cash carries the gap;
    3. **structural rejects** on both routes: 5 lines, a zero line among two, method `split`, a scalar `split` without `tenders`, Σ over the money cap. **Two cash lines:** 422 online, merged + `tender_cash_merged` on batch;
    4. **replay:** same key → one order; an altered body → key conflict;
    5. **legacy payload byte-identity:** a legacy payload and a one-line `tenders` payload give identical rows and flags;
    6. **read round trip:** `GET /orders/{id}` has `tenders` (synthetic for a tenderless fixture order), `refunds[].payoutSource`, and settings `splitTenderEnabled` (gap class);
    7. **shift close:**
       - before/after on pre-C6 fixtures (identical);
       - a split sale plus a cash payout refund, **asserting `total_orders`, `total_refunds` and `total_sales` and every bucket**;
       - a **cancelled** split order (counted nowhere);
    8. **reports:**
       - by-method maps sum to `total_sales`;
       - the order list filtered by QRIS includes the split order;
       - the summary filtered by QRIS shows only the QRIS line and QRIS-paid refunds (D-66);
       - a fully refunded split order keeps its per-method rows;
    9. **refunds:**
       - with `payoutMethod`, without it (default), and via a raw `status='refunded'` UPDATE (replaced trigger), with Go/SQL parity;
       - including a method configured `isCash:false` and a case-mismatched id;
    9b. **settings:**
       - a save without `splitTenderEnabled` keeps the stored value;
       - the first switch-on sets `split_tender_enabled_at`, and switching off keeps it;
    10. **ERP:** a document with two tenders, `tunai` → `cash`, refund tender = payout method;
    11. **reserved id:** a settings write with id `split` → 400.
  - **Gate wiring.** Add SP to the gate tuple. Any new top-level test in `internal/api` or `internal/codegen` goes into `scripts/ci/codegen_gate.py:18-19` (memory `codegen-gate-exact-test-set`).
  - **Backoffice vitest** for the totals fallback (tenders present or absent; refund method present or absent).
- **OTA journal guard:** not touched (backend + backoffice).
- **Release:**
  - merge;
  - Neon read-only checks (section 5);
  - `scripts/deploy-backend.sh c6a` (0079 runs at revision start);
  - smoke: `/readyz`, one normal sale on the tag through the release smoke, settings read shows `splitTenderEnabled:false`;
  - `scripts/promote-backend.sh c6a`;
  - post-deploy checks;
  - **24 h soak**.
  - The backoffice deploys on push and is safe either way (fallback).
- **Rollback:** Cloud Run back to `00147-giy` is safe while the setting has never been on (no `split` order, no `chosen` payout). 0079 is additive; the old binary ignores it, and orders it writes get synthetic lines.

### C6b: POS split mode + receipt + recap + refund payout + draft (OTA, after the C6a soak)
**Implement: Sonnet 5.5, medium-high. Review: Opus 5.5, high** (outbox payload, money shown to the cashier, refund flow).
- **Files.**
  - **Tender logic.**
    - `apps/pos/src/cashier/tenderSplit.ts` (new TS twin; reads `backend/internal/service/testdata/tender_golden.json`).
    - `tender.ts` (unchanged single-line path).
    - `cashierReducer.ts` (state and actions, 2.7).
  - **Checkout and payload.**
    - `CheckoutPanel.tsx` (split mode, reference field, Sisa/Lunas, chips from Sisa via `lib/quickCash.ts`).
    - `CashierScreen.tsx:357-359, 695-806` (`planSaleTender` at tap, payload `tenders` + summary scalars, `receiptSnapshot.tenders`, success view).
  - **Receipt.** `receiptQuote.ts`, `receiptRows.ts`, `ReceiptPreview.tsx`, `lib/paymentLabels.ts` (the "Campuran" label); `packages/printer/src/escpos.ts` (+ types).
  - **Local receipts and history.** `localReceipts.ts`, `LocalReceiptsPanel.tsx`, `OrderHistoryPanel.tsx`, `customerProfile.ts`.
  - **Recap.** `recapAggregate.ts:43-44` (per tender line, refunds by `refunds[].paymentMethod`, fallback to the order method); `refundRecap.ts:62-67` (`payoutMethod ?? paymentMethod`); `ShiftRecapPanel.tsx`.
  - **Refund.** `refundView.ts` (payload `payoutMethod` for split orders only), `RefundDialog.tsx` / `refundSelection.ts` (payout chips).
  - **Draft.** `heldOrders.ts` / `heldRestore.ts` (D-62).
  - **Sync.** `packages/sync/src/receiptArchive.ts:12-34, 66-89`, `engine.ts:1160, 1178` (copy `tenders`).
- **OTA journal guard impact.**
  - None of the touched files is in `OTA_JOURNAL_PATHSPECS` (`scripts/lib/ota-journal-guard.sh:23-34`: `journal*.ts`, `outbox.ts`, `outboxStore.ts`, `storage.ts`, `syncedRefunds.ts`, `partialRefunds.ts`, `bootStorage.ts`, `terminalBinding.ts`, `apps/pos/android`).
  - The payload is an untyped record, and the draft uses app KV through the held-orders API.
  - The OTA still needs **one `OTA_JOURNAL_CHANGE_ACK=1`**, because `partialRefunds.ts` was added since the APK base (RUNBOOK rule 4 re-asks for every later OTA on that versionCode). Reason: "no journal-adjacent change since 2.4.0".
  - Re-run the guard to confirm.
- **Tests.**
  - **POS vitest:**
    - golden parity;
    - reducer: add/remove/merge cash, cap at Sisa, N lines, clear on close/reset;
    - total change after lines (points, promo drop), stale plan refused;
    - payload snapshot: one-line payload has `tenders` length 1 and the same scalars as today; split payload;
    - receipt rows parity with the slip decode;
    - recap per line, with fallback;
    - refund payout chips: split only, default preselected;
    - draft save/restore/delete.
  - **Printer vitest:** tender rows and the reference line.
  - **Sync vitest:** archive copy of `tenders`; old entries without `tenders`.
  - **Browser scenarios** (add to `tests/browser/required-scenarios.json`):
    - **POS-SPLIT-TENDER:** QRIS 751k + cash 600k with change 100k; receipt rows; Riwayat "Campuran"; recap rows;
    - **POS-SPLIT-OFFLINE:** offline split sale, reconnect, ack, server `tenders`;
    - **POS-SPLIT-REFUND:** refund one line of a split order with the cash payout default, then the QRIS chip;
    - **POS-SPLIT-OFF:** with the setting off, no "Bagi pembayaran" (and none against a settings response without the key);
    - **POS-SPLIT-DRAFT:**
      - add a QRIS line, reload the page, restore prompt;
      - **kill/reload right after the enqueue:** no prompt, one queued sale, and the same `orderUuid` as the draft.
  - The existing "cash sale in four taps" and guest QRIS scenarios stay unchanged.
- **Release:** OTA 2.5.0 (web layer, no APK). The setting is still off, so cashiers see no change apart from the reference field (D-59).
- **Rollback:** the previous bundle is safe (2.5).

### C6c: backoffice display, CSV, toggle, admin refund payout (after C6a; before enabling)
**Implement: Sonnet 5.5, medium. Review: Opus 5.5, medium** (money display; one write field). Spec check: Haiku 5.5, low.
- **Files.**
  - **Orders.** `Orders.tsx`: list "Campuran", detail lines with reference and change, CSV `Pembayaran` "QRIS 751.000; Tunai 500.000", `⚠ Bayar` labels for `tender_short` / `noncash_overpay`.
  - **Filter.** `orderQuery.ts:21` (copy: "berisi metode"); `lib/paymentOptions.ts` (exclude `split`, add a "Campuran" option).
  - **Exports.** `ExportTab.tsx:63` (refund CSV uses `r.paymentMethod`).
  - **Customers.** `CustomerDetailSections.tsx:181-185`.
  - **Refunds.** `OrderRefundSection.tsx` (payout and source); the admin refund form payout chips for split orders (direct route `payoutMethod`).
  - **Sync review.** `reviewLabels.ts` (tender summary, `payoutMethod`).
  - **Settings.** `TransaksiSection.tsx` ("Bayar terpisah" toggle with the D-50 warning text; the reserved-id error).
- **Tests:** vitest formatters and CSV; browser **BO-SPLIT-ORDER** (detail, filter, CSV row) and **BO-SPLIT-TOGGLE**.
- **Release:** Cloudflare on push (needs C6a live for the new fields; it falls back without them).

### Enable (owner, after C6b + C6c)
1. Check `/ota/check` logs: every active tablet is on ≥ 2.5.0.
2. Run the on-device checks (section 5).
3. The owner turns on "Bayar terpisah".
4. From now on the C6a rollback rule applies (2.5).

**Release order:** demo (2 Nov) → C6a deploy → 24 h soak → C6b OTA → C6c → fleet check → enable. C6c can go any time after C6a.

---

## 5. Risks (ranked), checks and test plan summary

1. **A split payload reaches a server without C6a and is silently flattened** (`sync.go:316` plain decode).
   - Mitigations:
     - the setting comes from the server, so an old server leaves the UI off;
     - server first;
     - the no-rollback rule;
     - `receipt_snapshot.tenders` lets a repair script rebuild the lines.
2. **A money reader keeps grouping by `orders.payment_method`,** so cash goes missing into a `split` bucket.
   - Mitigations:
     - the reader table (1.4);
     - one gate subtest per server reader;
     - the sentinel makes a miss visible;
     - invariant queries (below).
3. **A refund of a split order records `split`** (legacy payload or old trigger), so the drawer and the ERP are wrong. Mitigation: the Go default plus the replaced trigger, with parity subtest 9.
4. **A partial payment is lost when Android kills the app during an EDC/QRIS switch**, so the customer is charged and no sale exists. Mitigation: the D-62 draft and the D-63 confirm.
   - The reverse failure is that the draft re-confirms a sale already queued, which is a second sale and maybe a second collection. Mitigation: the draft owns the order uuid (one idempotency key), it is deleted inside the sale gate, and drafts already queued or archived are dropped on start (2.7).
5. **The TS and Go allocations drift,** causing flags or a blocked Konfirmasi. Mitigation: the shared golden file.
6. **The total changes after lines are entered** (points, reward, a promo dropped at confirm). Mitigation: a re-plan at tap time that refuses a stale plan.
7. **Old bundles mis-show split orders** (raw label, cash missing from their local recap). Mitigation: enable only once the whole fleet is on C6b.
8. **The ERP payload changes for `tunai`** (D-61). Low risk: the ERP stores tenders as JSON and validates only method ≤ 30 characters and integer amounts.
9. **Lateral read cost at 30k-500k orders.** Mitigation: PK index on `(order_id, seq)`, `EXPLAIN` of shift close and the report on Neon in C6a, and the fragment kept per-order (never a global view scan).

**Read-only checks on the Neon test DB before C6a** (memory `neon-e2e-verification`; secrets from Secret Manager, never pasted; one read-only transaction; per-query connections because of the stale-connection transient):
```sql
-- methods in use (expect no 'split'; list custom ids for D-61)
SELECT payment_method, count(*), sum(total) FROM orders GROUP BY 1 ORDER BY 2 DESC;
SELECT payment_method, count(*) FROM order_refunds GROUP BY 1;
SELECT payment_methods FROM app_settings;
-- tender flags and captured-vs-total gaps (synthetic lines keep these exactly)
SELECT tender_warning_reason, count(*) FROM orders GROUP BY 1;
SELECT count(*) FROM orders WHERE abs((amount_paid - change) - total) > 1;
-- snapshot to compare after the deploy (must be identical)
SELECT id, total_sales, cash_sales, card_sales, transfer_sales, qris_sales, total_refunds, cash_refunds_paid,
       refunds_paid_by_method FROM shifts ORDER BY opened_at DESC LIMIT 20;
-- ERP sale documents that carry no tender today (D-61 sizing); check the erp_outbox ref column name first
```
After the deploy, run the same shift snapshot plus the report summary for the last 30 days (expect identical), and:
```sql
SELECT o.id FROM orders o JOIN order_tenders t ON t.order_id = o.id
 GROUP BY o.id, o.total HAVING abs(sum(t.amount) - o.total) > 1;              -- expect 0 rows
SELECT count(*) FROM order_refunds WHERE payment_method = 'split';            -- expect 0
SELECT count(*) FROM orders WHERE payment_method = 'split';                   -- rollback guard (0 until enabled)
```
- **Write smokes** (a throwaway split sale and refund on the tag URL, cleaned up) need the owner's per-request go-ahead.

**On-device checks** (after C6b, with the setting on in the test env):
- a real EDC charge, then a cash remainder with change;
- the printed slip rows and the reference;
- switching to the QRIS/e-wallet app mid-split and back (warm return keeps the lines; a cold start shows the draft prompt);
- an offline split sale synced later;
- a refund of a split order with each payout chip;
- the shift close with a split sale (the cash count matches only the cash line);
- the denomination counter unchanged.

---

## 6. Known gaps (not fixed by C6)
- **Custom non-cash method ids** still land in no shift bucket (`shift.go:196-199`), only in `total_sales`. They need their own slice: a per-method jsonb sales map on `shifts`.
- **A method flipped from cash to non-cash between capture and replay.** The batch merge covers the reverse case (D-52). Here the replayed split has no cash line, so the server flags a non-cash overpay and stores no change, while the cashier did hand out change. It is flagged, and the money taken is still in `tendered`. Admins should not change a method's "Tunai" flag while sales are queued (RUNBOOK note in C6a).
- **Tender method ids** are still not checked against the configured methods (`order_input.go:110-113`; "supported payment semantics" in A09 T07 stays open).
- **Refunds of single-method orders** keep the sale's method even when paid back differently (D-56 alternative).
- **No payment-method promo** (e.g. a bank card promo) exists. One would need tender-aware promo rules.
- **A09/T07.** C6 extends tender conservation to several lines. The tracker row stays "full A09/T07 open" (quote/settlement items unchanged).

---

## 7. Review (Opus `reviewer`, high, 2026-10-29): verdict "ship with fixes", all folded in
| Sev | Finding | Where fixed |
|---|---|---|
| HIGH | The checkout draft could re-confirm a sale already queued (uuid minted inside `engine.enqueue`) | 2.7 draft owns the order uuid, deleted inside the sale gate, start-up drop; D-62; risk 4; POS-SPLIT-DRAFT |
| HIGH | `appendOrderWhere` is shared by the list and the report summary (`read/reports.go:35, 37`), so an EXISTS rule would put the cash half of split orders under a QRIS-filtered report | 2.4 R4 (two rules), new D-66, subtest 8 |
| HIGH | Joining tender lines into the per-order shift aggregate double counts `total_orders`/`total_refunds` and revives cancelled orders; one-line fixtures cannot catch it | 2.4 R1 (two subqueries), subtest 7 (split + cancelled split) |
| MEDIUM | One-line parity broke on the zero-line rule (legacy non-cash 0 is accepted and flagged); blank cash input in split mode | 2.2, 2.3 table, golden cases |
| MEDIUM | Cash identity follows a changeable setting: a replayed offline sale could become "two cash lines"; SQL payout default must mirror `IsCashMethod` | 2.3 (batch merge + flag), D-52, D-54, 2.6 SQL rule, subtest 9 |
| MEDIUM | Rollback guard on the `split` order count misses offline tablets with the cached setting | 2.1 `split_tender_enabled_at`, 2.5 procedure |
| MEDIUM | A plain `bool` setting would be switched off by any save from an older form | 2.1 `*bool` (`write/settings.go:58-60` pattern), subtest 9b |
| MEDIUM | A scalar `split` without `tenders` hits the table CHECK (500, endless batch retry); Σ of lines can overflow `numeric(14,2)` | 2.2, 2.3 table, D-54, subtest 3 |
| LOW | Snapshot repair is not guaranteed (64 KB, valid quote only) | 2.2 "best effort" |
| LOW | Online shortfall handling differs from slice 8 Q5 for non-cash-only splits | 2.3 "deliberate difference", D-55 |
| LOW | Golden case for a non-cash overpay with a cash line (applied 0, change from the same allocation) | 2.3 golden list and the "applied may be 0" note |
| LOW | ERP builder needs settings for cash identity; case-insensitive ids; literal tests; frozen payloads | 2.4 R7 |
| LOW | Refund key reuse after a changed payout chip | checked: a fresh key per enqueue, queued payload immutable (2.6) |

Not checked by the reviewer (left to the slices): `codegen_gate.py` lines, `reportTotals.ts`/`metrics.ts` internals, `heldRestore` repricing, `confirmGuard.ts`, cached-settings persistence across a cold start, browser scenario JSON, `EXPLAIN` on Neon.
