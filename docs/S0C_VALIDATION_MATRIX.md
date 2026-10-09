# S0c sale-input compatibility and verification matrix

Packet S0C-20260920-01; 2026-09-20. Current-source evidence, not a replacement
for A01–A44 or the original T07 requirements. Authority: AUTH-MANDALIKA-20260919-01.
Incoming contract: CG-S0B-20260919-01-R2, responding to S0B-20260919-01.

## Boundary and effect trace

Direct `handlers/writes.go:CreateOrder` decodes `createOrderBody`, resolves the
authenticated caller and header key, then may return an existing Redis receipt.
Batch `sync/sync.go:processOneWithCommands` decodes `orderPayload`, maps the trusted
Caller and original item key, and sets Offline=true even for connected POS traffic.
Both public paths call `service/order.go:CreateOrder` -> `createOrder`.

The service keeps existing empty-items/outlet checks, opens its transaction and
looks up processed_keys. A known key retains the prior receipt return. For a new
command, ValidateSaleInput runs before promotion reads and all business writes.
Items are copied before existing reward resolvers compact/reprice them. Resolved
lines/grants, pricing, redemption arithmetic and earned/balance values are checked
before the first stock INSERT/UPDATE. Later writes remain in the existing transaction:
order, order_items, reward grants, customer aggregates/points, point ledger,
condition applications, promotion/code use, processed key, then commit.

The checks do not supply discretionary discount permission, prove a quote/payment,
change assigned-code identity/reissue, or authorize reward entitlement. Existing
resolver behavior remains, including current-reference repricing and offline
reward-dropping behavior. Only the detached caller slice is newly protected;
immutable server capture storage remains A10. Redis and processed_keys still lack
the full scope/fingerprint contract required by A11.

## Representation and compatibility

| Field/shape | Current source and supported domain | S0c check / result | Evidence |
|---|---|---|---|
| Retail quantity | `service.OrderItem.Quantity int`; `0001_init.sql` integer. Current POS uses whole bottle counts. | Required non-null numeric JSON; typed int rejects fraction/string/out-of-Go-range; shared check requires 1..2147483647. Applies equally to reward/bundle/offline flags. | Negative/zero red-before/green-after; wire/domain tests; real DB direct/batch -1,0,1.5,string,int4 overflow, unchanged rows. |
| Captured price/subtotal | Required by CreateOrderRequest item contract; SQL numeric(14,2), maximum 999999999999.99. Zero free lines are valid. | Required non-null numbers; finite, nonnegative and within representation range. No catalog lookup. Fractional calculated unit prices remain supported; not an integer-rupiah mandate. | Domains/wire tests and DB negative amounts/free sales. |
| Captured line arithmetic | `useCart.ts` / `cashierReducer.ts` use rounded price*quantity; CashierScreen BXGY may send net*count without whole rounding; freed bundles round subtotal. | Product and aggregate bounds checked. Subtotal cents must equal captured product cents OR existing whole-rupiah product rounding. This is representation consistency, not quote authenticity. | Decimal, fractional BXGY net, rounded bundle, mismatch, product/sum overflow tests. |
| Server-resolved bundle | `resolveBundleLines`: subtotal=round(sum nets), price=round(sum/qty); rounded average need not multiply exactly. | Finite/range/positive-quantity/aggregate checks after resolution, without imposing captured equality/product-range on the rounded average. No client flag bypass: equality is still required on input. | Unit allocated 333*3 vs 1000; real DB bundle 3 grants, total net/subtotal 1000, 3 physical units. |
| Loyalty/reward/free and static bundle | Explicit 0 price/subtotal, positive quantity, IsReward/RewardConditionID; static IsBundle SKU is distinct from promotion bundle. | No blanket positive price/total/tender requirement. Existing entitlement/resolution retained. | Unit shapes; DB free/static/full-discount; real BXGY grant net 55000, quantity2/subtotal155000; existing pricing/loyalty suite. No claim of every loyalty-condition DB permutation. |
| amountPaid | Optional legacy number; POS sends entered cash or derived noncash total. Null/absent decode to zero as before. | Finite, nonnegative and numeric money range. No comparison to today's recalculated total. | Negative/nonfinite/range tests; direct legacy null optional fields; DB cash and configured bca with missing tender. |
| Method | SQL migration `0005_payment_method_freeform.sql` removes enum restriction. Existing configured IDs can outlive current settings. | Nonblank identifier; no invented closed enum or proof of settlement. | neo_bank/bca compatibility; empty-method error. |
| Manual discount/surcharge | Optional/null legacy inputs map to zero. Existing percentage/fixed behavior and discount cap remain. | Finite/nonnegative money-representation range on stored input. Computed persisted money range checked; finite intermediate capped discount/redemption may exceed stored limits before existing caps. | Domain tests; derived tax/surcharge overflow and nonfinite tax; DB negative discount/surcharge; full-discount remains valid. No new percentage policy. |
| Points | Request int; persisted points integer; existing clamp/redemption/whole-point behavior retained. | Request 0..int4max; finite/range base/final earned and resulting balances before writes. | Negative/overflow request and helper range tests; existing loyalty suite. No exhaustive configured-condition aggregate overflow proof. |
| Guest/customer/code | Guest needs no customer/phone. Assigned-code subject/reissue remains Q08. | No new customer requirement or code retargeting. Caller items copied; existing effective-customer resolution unchanged. | Guest DB fixtures; source diff and preserved Q08 excerpts. |
| Timestamps/Offline/alreadyPaid/roles | Batch preserves ClientCreatedAt and authenticated Caller. Payload Offline is not authority; real batch always sets true. | Flags do not bypass input checks or grant refund permission. No capture-time authority claimed. | Synthetic JWT direct/mapping tests, preserved S0b tests, real authenticated mixed batch with forged scope and denied refund. |
| Legacy unknown fields | Existing loose decoding accepts forward-compatible metadata; required line price/quantity/subtotal are present in inspected producers. Optional adjustments/tender remain nullable. | Unknown fields remain ignored. Missing/null required line numerics now fail, not invented zero/free value. Shared OrderItem decoder also applies to loyalty preview, whose POS producer supplies full cart lines. | Wire test; direct optional-null fixture; inspected POS preview/capture. Historical external clients with undocumented missing line fields are not surveyed. |

Errors: malformed direct bodies retain HTTP 400; service domain errors return 400
with an actionable retention/no-repeat-collection message. Batch errors retain
the original key with status=error; independent successes continue. Error messages
do not ask for another payment. Client production code is unchanged: normal failure
attempts/parking apply, unresolved items remain available to the diagnostics panel.
S0a's export path remains non-destructive. No claim of complete A37 redaction.

## C01–C12 acceptance evidence

| ID | Result and actual layer | Remaining limit |
|---|---|---|
| C01 | Pre-fix four cases reached first stock-write spy; identical assertion passes after. Real authenticated direct/batch DB requests reject negative/zero and leave business rows unchanged. | Not a hostile live request. |
| C02 | Wire, int4, product/sum bounds and internal NaN/Inf tests pass; real DB malformed/fractional/out-of-range quantity requests leave rows unchanged. | Schema upper quantity bound does not bound CPU/memory of existing quantity-expanded promotions. |
| C03 | Shared negative/nonfinite/range and derived tax/surcharge guards pass before-effect spies; real DB negative price/subtotal/tender/discount/surcharge leave rows unchanged. | Not every configuration arithmetic, persisted aggregate overflow or database race. |
| C04 | Real authenticated direct cash, free-form bca (omitted legacy tender) persist supported totals/payment; mixed batch succeeds. | No external card/transfer settlement proof; existing noncash overwrite remains. |
| C05 | Unit free/decimal/rounded shapes and existing pricing/loyalty suites pass; DB free/full-discount/static bundle/BXGY/generated bundle with grants and allocated subtotal pass. | Every historical client and loyalty reward condition not exhaustively sampled. |
| C06 | Real DB captured price100000 vs current catalog110000 and tax10% produces total110000 with cash paid100000; capture is not rejected by new guard. | **Partial:** existing quoted_total=110000 is recalculated, not original quote; promotion/reward/loyalty history still mutable. A10 remains open. |
| C07 | Transaction fixture asserts direct zero-floor and offline negative/warning; DB positive batch quantity at stock0 persists -1 and warning. | Existing direct floor remains A44; no new stock-availability denial. |
| C08 | Real direct/batch handlers, JWT/store enrichment, services/DB plus shared-boundary tests. Mixed batch valid order succeeds; bad order and unauthorized refund return individual errors. | Not full router/proxy/rate-limit/Redis or browser-to-server integration. |
| C09 | Actual SyncEngine, successful memory KV: five denials, pending/parked counts, repeated export, unchanged stored evidence, reconstruction, same-key manual retry and continued denial; no ack/discard. | Not native durability or a complete recovery/error journal. Existing lastError/attempt reset semantics unchanged. |
| C10 | Committed DB receipt then same-key retry, including changed negative quantity, returns duplicate without changing compared rows. Transaction-spy variant also passes. | **Partial:** simulates lost response by discarding result; no network interruption/race. Existing global key lookup does not compare fingerprint/scope. |
| C11 | Preserved S0b JWT/permission suites pass; real DB mixed batch refuses forged refund authority and ignores forged sale outlet/cashier IDs. | No immediate revocation or historical capture authority; full A06 stays open. |
| C12 | Fresh affected Go packages, sync29, POS160, typechecks; real PostgreSQL18.3 integration with45 existing migrations. | Server package has no tests; no Android/device, Redis, payment-provider, race/restore/release validation. |

Database evidence compares full JSON aggregates (including IDs/timestamps) of
orders, items, outlet stock, customers, discount codes, point transactions,
condition applications, promo grants and processed keys before/after denied inputs.
Synthetic references are seeded; version metadata is seeded before comparisons.
Valid cases inspect persisted outcomes/grants. This is stronger than a fake write
count, but does not prove all rows/configurations/concurrency behavior in production.

## Consequential design questions for ChatGPT

**Q-S0c-01 — original quote/tender and legacy recovery.** Current POS queue payload
in CashierScreen contains lines, amountPaid, adjustments and points but no independent
captured subtotal/tax/total/rule version. `order.go` writes quoted_total=finalTotal;
noncash amountPaid is replaced with finalTotal. Existing promotion/reward resolution
uses current data. DB C06 confirms cash mismatch is possible. Options: (A) version
and retain an immutable captured quote/tender plus separate reconciled result and
explicit legacy-unknown review; (B) infer original quote from current calculation
(unsupported); (C) deny all legacy captured records (strands evidence). Recommend A,
co-designed with A11 scoped fingerprints/receipts and A28 error taxonomy. Preserve
legacy records and actual payment; never infer a second collection. Please specify
the minimum capture and receipt contract before dependent schema/behavior changes.
This is a design question, not a request for execution permission.

**Q-S0c-02 — representation range versus computation work.** `pricing.go`
quantity-expanded BOGO/BXGY/bundle calculations and `order.go:resolveBundleLines`
can allocate per unit. int4 validity alone permits billions of units, including
zero-price lines. Options: (A) count-compressed calculations preserving current
allocation semantics, plus a retained/error path for work that cannot yet be
bounded; (B) invent a retail quantity cap; (C) leave the exposure indefinitely.
Recommend A, with property/parity tests against existing small-unit algorithms,
separate from a customer quantity/spend policy. No arbitrary cap or algorithm rewrite
was introduced in S0c. Please review the computational contract/transition handling;
A40 and full A09 remain open. Independent A43 decode work can proceed.
