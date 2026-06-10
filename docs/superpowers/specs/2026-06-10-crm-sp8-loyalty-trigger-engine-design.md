# SP-CRM-8 — Loyalty-Conditions Trigger Engine — Design

Date: 2026-06-10 · Branch: `prod-hardening` · Module: CRM (Customers)
Status: **APPROVED — ready for planning**

## Problem

The `loyalty_conditions` table is CRUD'd in the backoffice (Loyalitas → Kondisi Khusus) and
listed via `/loyalty-conditions`, but it is **never evaluated anywhere**. Every order earns a
flat `base = floor(total/1000) × pointsPerThousand` (computed in `service/pricing.go`
`Compute`, gated on `loyaltyEnabled && hasCustomer`). The marketing engine the conditions
were built for — variable/bonus points on birthdays, member days, spending thresholds,
specific products, campaigns — does nothing.

SP-CRM-8 wires the condition-evaluation engine into the earning path so an order earns
variable points, writes the SP-CRM-7 points ledger, and records an audit trail of which
conditions fired. This is the **second consecutive slice on the hot order/earning path**
(after SP-CRM-7), so it carries the same care: math correctness, idempotency via the
existing `processed_keys` transaction guard, and **no prod pollution to verify**.

> **NOTE:** Loyalty is currently **OFF in prod** (`loyalty_settings.enabled = false`).
> Earning is dormant; this engine stays inert until the business enables loyalty. The live
> e2e briefly toggles it on→off (defer-restored) to prove the path, exactly like SP-CRM-7.

## Current state (grounding)

- **`service/pricing.go` `Compute`** returns `EarnedPoints = int(floor(total/1000) × PointsPerK)`
  when `LoyaltyEnabled && HasCustomer`, else `0`.
- **`service/order.go` `CreateOrder`** (one tx, idempotent on `IdempotencyKey` via
  `processed_keys`): loads loyalty settings → `Compute()` → inserts the order (persists
  `points_earned`) → updates `customers.points` → writes the SP-CRM-7 `earn`/`redeem` ledger
  entries via `write.InsertPointTx`. The customer row is locked `FOR UPDATE` but **only
  `points`** is read today.
- **`Refund`** (SP-CRM-7) already reverses points by clawing back `orders.points_earned`
  (floor-0 + forgiveness) and restoring redeemed points.
- **`loyalty_conditions` schema** (`0001_init.sql`):
  `name`, `type` CHECK(`always_on`|`campaign`), `trigger` (free text),
  `reward_type` CHECK(`set_points`|`multiply_points`|`product_reward`), `reward_value`
  numeric, `reward_product_ids` jsonb, `campaign_start_date`/`campaign_end_date` date,
  `active_days` jsonb, `applicable_product_ids` jsonb, `minimum_spend` numeric, `is_active`.
- **Backoffice semantics** (`Customers.tsx` `TRIGGER_OPTIONS`/`REWARD_OPTIONS`):
  - 7 triggers: `first_registration` (Registrasi Pertama), `birthday` (Ulang Tahun Member),
    `anniversary` (Hari Jadi Member), `double_date` (Double Date — tgl = bln),
    `member_day` (Member Day — hari tertentu), `product_purchase` (Pembelian Produk Tertentu),
    `spending_threshold` (Capai Target Belanja).
  - 3 rewards: `set_points` (Set Poin — langsung diberi), `multiply_points` (Pengali Poin),
    `product_reward` (Reward Produk Gratis).
  - The form binds `active_days` only to `member_day`, `applicable_product_ids` only to
    `product_purchase`, `minimum_spend` only to `spending_threshold` → each is that trigger's
    parameter, not a universal filter.
  - `DAYS_ID = ['Minggu','Senin',...,'Sabtu']` → index 0 = Sunday, matching Go
    `time.Weekday` (Sunday=0) and JS `getDay()`. No off-by-one.
- **The server trusts the POS-supplied item list** — it never injects order items (bundles
  are expanded client-side). This is why `product_reward` free-item *injection* is out of
  scope here (see Decisions).

## Decisions (locked with user)

1. **Reward scope:** `set_points` + `multiply_points` ship fully (points → SP-CRM-7 ledger).
   `product_reward` is **evaluated + recorded** (audit row, backoffice-visible); actual
   free-item fulfillment (order_items / stock / receipt) is **deferred to a future POS slice**
   — it is inherently POS/receipt-coupled and this module is backoffice-now / POS-later.
2. **Stacking model:** `earned = round(base × bestMultiplier) + Σ(matching set_points)`.
   - `bestMultiplier` = the **single highest** `reward_value` among matching `multiply_points`
     conditions with `reward_value > 0`; `1.0` if none. **Multipliers do NOT compound.**
   - `flatBonus` = sum of `reward_value` of all matching `set_points` conditions with
     `reward_value > 0`. Flat bonuses are **added after** the multiplier (not multiplied).
   - Base always applies (under the existing loyalty+customer gate); conditions add on top.
3. **Eval date source:** the order's **sale moment** = `client_created_at` converted to
   **WIB (UTC+7, fixed zone — Indonesia has no DST, so `time.FixedZone` needs no tzdata)**;
   fallback to server `now()` in WIB when `client_created_at` is nil (older apps). Chosen so an
   offline birthday sale synced days later still counts on the actual sale day.
4. **Recording:** full audit — **one append-only row per applied condition** in a new
   `loyalty_condition_applications` table (gives campaign ROI reporting and product_reward its
   home).
5. **Pre-existing bug fix (in scope):** the backoffice Loyalitas `loyaltyForm` is initialized
   from `DEFAULT_LOYALTY` and never synced from fetched `lq.data`, so "Simpan Pengaturan"
   clobbers untouched fields (`enabled`/`pointsPerThousand`/`redemptionRate`) with defaults.
   Fix by seeding the form from `lq.data` on load (all fields, not just the `tierEnabled`
   workaround SP-CRM-5b added).
6. **POS divergence (accepted):** the POS checkout still shows the flat estimate
   `floor(total/1000)×ppt`; the server now earns ≥ that. The printed receipt/POS "poin" line
   under-states actual earned points until a future POS slice mirrors the engine. Acceptable:
   server is authoritative, the customer never earns *less* than shown, and the cached balance
   + backoffice reflect the true number.

## Architecture

### Unit 1 — the evaluation engine (pure, TDD'd): `backend/internal/service/loyalty.go`

A pure function with no DB access, fully table-testable:

```go
type LoyaltyCondition struct {
    ID, Name, Type, Trigger, RewardType string
    RewardValue        float64
    RewardProductIDs   []string
    CampaignStartDate  *time.Time // date-only (nil for always_on)
    CampaignEndDate    *time.Time
    ActiveDays         []int      // weekday indices, Sunday=0
    ApplicableProductIDs []string
    MinimumSpend       *float64
}

type EvalContext struct {
    Total      float64          // res.Total (pre-redemption)
    BasePoints int              // res.EarnedPoints — the flat base; needed for multiply attribution
    ProductIDs map[string]bool  // set of order item product IDs
    SaleDate   time.Time        // WIB, date component used for MM-DD / day / weekday
    Customer   EvalCustomer     // Birthday *time.Time, Anniversary *time.Time, VisitCount int
}

type AppliedCondition struct {
    ConditionID, Name, Trigger, RewardType string
    RewardValue       float64
    RewardProductIDs  []string
    PointsContributed int // for the ledger breakdown + application row (0 for product_reward)
}

type LoyaltyOutcome struct {
    BestMultiplier float64
    FlatBonus      int
    Applied        []AppliedCondition // every matched condition (points + product_reward)
}

func EvaluateLoyalty(conds []LoyaltyCondition, ctx EvalContext) LoyaltyOutcome
```

**Eligibility** (a condition matches when ALL hold):
- `is_active` (only active conditions are passed in — the read filters them), AND
- date-window: `type == "always_on"` OR `SaleDate` ∈ `[CampaignStartDate, CampaignEndDate]`
  inclusive (date-only comparison in WIB), AND
- the trigger predicate:

| trigger | predicate |
|---|---|
| `first_registration` | `Customer.VisitCount == 0` (read under FOR UPDATE, before increment) |
| `birthday` | `Customer.Birthday != nil` AND its `(month,day)` == `SaleDate`'s `(month,day)` |
| `anniversary` | `Customer.Anniversary != nil` AND its `(month,day)` == `SaleDate`'s `(month,day)` |
| `double_date` | `SaleDate.Day() == int(SaleDate.Month())` |
| `member_day` | `int(SaleDate.Weekday()) ∈ ActiveDays` |
| `product_purchase` | `ApplicableProductIDs` non-empty AND order contains ≥1 of them |
| `spending_threshold` | `MinimumSpend != nil` AND `Total >= *MinimumSpend` |

**Reward folding** over matched conditions:
- `multiply_points` with `RewardValue > 0` → candidates for `BestMultiplier = max(values)`;
  `1.0` if none. (Values ≤ 0 ignored to prevent a misconfigured ×0 zeroing base. Deliberate
  fractional multipliers like ×0.5 are respected if > 0.)
- `set_points` with `RewardValue > 0` → `FlatBonus += round(RewardValue)`.
- `product_reward` → recorded in `Applied` with `PointsContributed = 0` and its
  `RewardProductIDs`; contributes no points.
- Every matched condition (all three reward types) appears in `Applied`. For points-type
  conditions, `PointsContributed` is the engine's attribution for the audit row:
  - `set_points`: `round(RewardValue)`.
  - `multiply_points`: the single winning condition (the one supplying `BestMultiplier`)
    records `round(BasePoints × BestMultiplier) − BasePoints`; all other matched multiply
    conditions record `0`. On a tie for the max multiplier, the winner is the **first** matched
    condition in deterministic order (the read returns conditions `ORDER BY created_at, id`), so
    attribution is stable across replays.
    *(Attribution detail — final earned is computed in CreateOrder as
    `round(BasePoints × BestMultiplier) + FlatBonus`, not by summing PointsContributed; the
    per-row number is for reporting only and, by construction, the multiply rows + set_points
    rows sum to `finalEarned − BasePoints`.)*

**Edge semantics** (must be covered by tests):
- No matched conditions → `BestMultiplier=1.0, FlatBonus=0, Applied=[]` → `finalEarned == base`
  (byte-identical to today).
- WIB midnight boundary: a UTC instant at 22:00Z (= 05:00 WIB next day) evaluates as the WIB
  day, not the UTC day.
- Campaign window edges inclusive on both ends (date-only).
- `birthday`/`anniversary` Feb-29 dates: exact `(month,day)` match only (no fold) — a Feb-29
  birthday matches only in leap years. (Documented; out of scope to "fold" since there is no
  window field. Flag in review if the business wants Feb-29 → Feb-28/Mar-1 folding.)

### Unit 2 — the read: `ActiveLoyaltyConditions(ctx, tx) ([]service.LoyaltyCondition, error)`

A focused read (new, in `read` or alongside the order service) that selects **only active**
conditions and scans them into the Go struct above (NOT the JSON `api.LoyaltyCondition` used by
the backoffice list). jsonb arrays (`active_days`, `applicable_product_ids`,
`reward_product_ids`) decode to Go slices; nullable dates/`minimum_spend` to pointers. Read
inside the order tx for a consistent snapshot. Conditions are global config (no row lock needed).
Ordered `ORDER BY created_at, id` so multiply-tie attribution (Unit 1) is deterministic.

### Unit 3 — wiring into `CreateOrder` (`service/order.go`)

1. Expand the existing customer `FOR UPDATE` select to also load `birthday`, `anniversary`,
   `visit_count` (same row already being locked — one query, no extra lock).
2. After `Compute()` yields `base = res.EarnedPoints`:
   - If `hasLoyaltyCustomer`: load active conditions, build `EvalContext`
     (`BasePoints` = `base`; `Total` = `res.Total`; `SaleDate` = `client_created_at` or
     `now()`, in WIB; `ProductIDs` from `in.Items`; `Customer` from the locked row),
     call `EvaluateLoyalty`.
   - `finalEarned = int(math.Round(float64(base) × outcome.BestMultiplier)) + outcome.FlatBonus`.
   - If not a loyalty customer: `finalEarned = base` (which is already 0 when gated off).
3. `finalEarned` replaces `res.EarnedPoints` for: `orders.points_earned`, the
   `customers.points` update (`points = points + finalEarned − pointsRedeemed`), the `earn`
   ledger entry (`BalanceAfter = balanceBefore + finalEarned`), and the redeem entry's
   `BalanceAfter` arithmetic.
4. **Earn ledger reason** carries a human breakdown, e.g.
   `"Poin transaksi MDK-001 (dasar 50 ×2 + Ulang Tahun +100)"`. When no condition matches it
   stays the plain `"Poin dari transaksi MDK-001"`.
5. Insert one `loyalty_condition_applications` row per `outcome.Applied` entry, inside the tx
   (snapshots of condition_name/trigger/reward_type/reward_value; `points_contributed`;
   `reward_product_ids` for product_reward). Idempotent: same tx as the order (processed_keys
   guard) + the UNIQUE `(order_id, condition_id)` index.
6. The whole block is gated on `hasLoyaltyCustomer` (loyaltyEnabled && customer). Points need a
   customer to land on, so order-level triggers (double_date/member_day/spending_threshold/
   product_purchase) still require a customer to earn anything — consistent with base.

**Invariant:** when no condition matches, the points math is **byte-identical** to today
(`bestMultiplier=1.0`, `flatBonus=0`).

### Unit 4 — refund

**No points code change.** Refund already claws back `orders.points_earned`; since that column
now stores the *true* `finalEarned` (incl. bonuses), the existing clawback (floor-0 +
forgiveness) reverses the full amount correctly. `loyalty_condition_applications` rows are
**immutable order-time facts** — not reversed (the refund is its own recorded ledger event).
Physically-handed product rewards are not clawed back. *(Document this; no code.)*

### Unit 5 — data model: migration `0032`

`loyalty_condition_applications`:
- `id` uuid PK DEFAULT gen_random_uuid()
- `order_id` uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE
- `customer_id` uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE
- `condition_id` uuid REFERENCES loyalty_conditions(id) ON DELETE SET NULL
- `condition_name` text NOT NULL, `trigger` text NOT NULL, `reward_type` text NOT NULL,
  `reward_value` numeric(14,2) NOT NULL DEFAULT 0 (snapshots)
- `points_contributed` integer NOT NULL DEFAULT 0
- `reward_product_ids` jsonb
- `created_at` timestamptz NOT NULL DEFAULT now()
- INDEX `(order_id)`, INDEX `(condition_id, created_at DESC)`, INDEX `(customer_id, created_at DESC)`
- UNIQUE INDEX `(order_id, condition_id)`

### Unit 6 — backoffice + API surface

- **Fix `loyaltyForm`:** seed from `lq.data` when loyalty settings load (all fields). Removes
  the clobber footgun for the very settings that gate this engine.
- **Kondisi Khusus list:** each condition row shows **"Terpakai: N"** — add a correlated
  `appliedCount` to the existing `LoyaltyConditions` read (count of applications for that
  condition). No new endpoint, mirrors how discount codes show usage.
- **product_reward grants:** `GET /customers/{id}/reward-grants` (gated `manage_customers`)
  → the customer's `product_reward` applications. Rendered as a small "Reward Produk" list on
  `CustomerDetail.tsx` so staff can honor them in the POS-less interim.
- *This backoffice surface is the trimmable part — can be reduced/expanded at spec review._

### Backend change recipe (per project convention)

`openapi.yaml` (new `LoyaltyConditionApplication`/reward-grants response + `appliedCount` on
`LoyaltyCondition`) → `go tool oapi-codegen` → `pnpm --filter @mandalika/api gen` →
build/test → `make gen-check` (commit `api.gen.go`). OpenAPI paths use `/api/v1/...`; Go route
registration is un-prefixed. New route registered before `/customers/{id}` if it could collide
(it doesn't — `reward-grants` is a distinct sub-path).

## Testing & verification

1. **Unit (TDD) — `EvaluateLoyalty` table-driven:**
   - Each trigger: a matching and a non-matching case.
   - Campaign window inclusive edges; always_on ignores dates.
   - WIB midnight boundary (UTC instant that crosses the WIB day).
   - Multi-match stacking: base×bestMultiplier + summed set_points; multipliers do NOT compound
     (×2 and ×3 present → ×3, not ×6).
   - `reward_value ≤ 0` ignored (no zeroing, no negative bonus).
   - No-match → `finalEarned == base` parity.
   - `first_registration` only when `VisitCount == 0`.
2. **DB (pgx throwaway, tx rolled back):** migration 0032 table + 3 indexes + UNIQUE exist;
   the UNIQUE `(order_id, condition_id)` actively rejects a duplicate insert. Throwaway deleted.
3. **Live e2e (real `service.OrderService`, SP-CRM-7 pattern):** in a throwaway `cmd/`,
   briefly toggle `loyalty_settings.enabled` on (restore to false immediately + via defer),
   seed a temp customer (with a birthday == today WIB) + a temp `set_points` condition + a temp
   `multiply_points` condition + a temp `product_reward` condition, create orders proving:
   base×bestMultiplier + flatBonus earned; one `earn` ledger entry with the breakdown reason;
   one application row per matched condition; product_reward grant recorded with
   `points_contributed=0`; **replay is idempotent** (no double earn, no double application).
   Then **DELETE all artifacts** (applications/point_transactions/order_items/processed_keys/
   orders/conditions/customer), restock net-zero. Confirm `loyalty_settings.enabled` back to
   false. **Do not pollute prod.**
4. **Builds:** backend `go build`/`go test` (no `-race` locally — no cgo on this box; CI runs
   race on Linux); backoffice `tsc -b` + `vite build`. `make gen-check` clean.
5. **Two-stage review per batch:** spec-compliance reviewer + go-reviewer (Go) /
   typescript-reviewer (backoffice).

## Out of scope

- `product_reward` free-item **fulfillment** (order_items injection / stock / receipt) — POS slice.
- POS checkout showing the **real** earned points at the register — POS slice.
- **Birthday/anniversary windows** (the table has no window field; exact-day only).
- Feb-29 birthday **folding** (exact `(month,day)` match only; flag if the business wants it).
- Per-condition backoffice **analytics dashboards** beyond the fired-count.
- Phone normalization, the dup-merge queue (SP-CRM-Merge) — separate slices.

## Risk notes

- **Second consecutive hot-earning-path slice.** The byte-identical-when-no-match invariant is
  the safety anchor; the live e2e must prove both the new earning AND that an order with no
  matching condition still earns exactly `base`.
- **Idempotency** rides the existing `processed_keys` tx guard; the UNIQUE `(order_id,
  condition_id)` is a second belt.
- **WIB fixed-zone** avoids tzdata/DST entirely (Indonesia has no DST).
- **Loyalty is OFF in prod** → the engine is dormant on deploy; zero risk to live orders until
  the business enables loyalty. Verification toggles it on→off transactionally.
