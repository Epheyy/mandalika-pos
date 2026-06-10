# SP-CRM-8 — Loyalty-Conditions Trigger Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the unwired `loyalty_conditions` table into the order earning path so an order earns variable/bonus points (base × best multiplier + summed flat bonuses), writes the SP-CRM-7 points ledger, records a per-condition audit trail, and records (but does not yet fulfill) product rewards.

**Architecture:** A pure, table-tested evaluation engine (`service/loyalty.go`) decides which conditions match an order and folds rewards into a multiplier + flat bonus + applied-condition list. `CreateOrder` loads active conditions inside its existing idempotent tx, calls the engine, computes `finalEarned`, and writes it everywhere `res.EarnedPoints` was used plus one append-only `loyalty_condition_applications` row per matched condition. Refund needs no points change (it already claws back the stored `orders.points_earned`). Backoffice gets the pre-existing `loyaltyForm` clobber-bug fix, a per-condition "Terpakai: N" count, and a customer reward-grants list.

**Tech Stack:** Go 1.x + pgx/v5 + chi; oapi-codegen; PostgreSQL (Neon); React + TypeScript (Vite) backoffice; pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-06-10-crm-sp8-loyalty-trigger-engine-design.md` (commit `4e36b15`).

**Conventions (from the spec + repo):**
- WIB = `time.FixedZone("WIB", 7*3600)` (Indonesia, no DST → no tzdata needed).
- Stacking: `finalEarned = round(base × bestMultiplier) + Σ(set_points)`; multipliers do NOT compound; `reward_value ≤ 0` ignored.
- Eval date = `client_created_at` in WIB, fallback `now()` in WIB.
- Everything is gated by `hasLoyaltyCustomer` (loyaltyEnabled && customer present), same as base today.
- **Invariant:** when no condition matches → `bestMultiplier=1.0`, `flatBonus=0` → `finalEarned == base` (byte-identical to current behavior).
- Loyalty is OFF in prod → the engine is dormant on deploy. NEVER pollute prod to verify (toggle on→off transactionally in a throwaway).
- `-race` not available locally (no cgo on this box) — run `go test` without it; CI runs race on Linux.
- Commit hook false-positives on chained `git commit && …` → run `git add` then `git commit` as separate commands; never `--no-verify`.

---

## File Structure

**Backend — create:**
- `backend/internal/db/migrations/0032_loyalty_condition_applications.sql` — the audit table + indexes.
- `backend/internal/service/loyalty.go` — the pure evaluation engine (no DB import).
- `backend/internal/service/loyalty_test.go` — table-driven engine tests.

**Backend — modify:**
- `backend/internal/service/order.go` — `loadActiveConditions` tx read; wire the engine into `CreateOrder`; write application rows; breakdown reason.
- `backend/internal/write/points.go` (or a new `backend/internal/write/loyalty.go`) — `InsertConditionApplication` helper. (Plan creates `write/loyalty.go` to keep `points.go` focused.)
- `backend/internal/read/repo.go` — `appliedCount` on `LoyaltyConditions`; new `RewardGrants` read.
- `backend/internal/handlers/writes.go` — `RewardGrants` handler.
- `backend/internal/server/server.go` — register `GET /customers/{id}/reward-grants`.
- `backend/api/openapi.yaml` — `appliedCount` on `LoyaltyCondition`; `RewardGrant` + `RewardGrantListResponse` schemas; the `/customers/{id}/reward-grants` path.
- `backend/internal/api/api.gen.go` — regenerated (committed).

**Frontend — modify:**
- `packages/api/src/client.ts` — `listRewardGrants` method (+ type import).
- `packages/api/src/schema.d.ts` — regenerated via `pnpm --filter @mandalika/api gen`.
- `apps/backoffice/src/screens/Customers.tsx` — fix `loyaltyForm` sync; "Terpakai: N" on the condition list.
- `apps/backoffice/src/screens/customers/CustomerDetail.tsx` — reward-grants list in the Poin area.
- `apps/backoffice/src/screens/customers/rewardTypes.ts` — create: reward-type label/format helper (mirror `pointTypes.ts`).

---

# BATCH A — Backend foundation (migration + pure engine + write/read helpers)

## Task 1: Migration 0032 — `loyalty_condition_applications`

**Files:**
- Create: `backend/internal/db/migrations/0032_loyalty_condition_applications.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 0032_loyalty_condition_applications.sql
-- SP-CRM-8: append-only audit of which loyalty_conditions fired on which order.
-- One row per matched condition (set_points / multiply_points / product_reward).
-- points_contributed is the engine's per-condition attribution for reporting; the
-- order's true earned total lives in orders.points_earned + the earn ledger entry.
-- product_reward rows carry reward_product_ids and points_contributed=0 (fulfillment
-- is deferred to a future POS slice).

CREATE TABLE loyalty_condition_applications (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id           uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  customer_id        uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  condition_id       uuid REFERENCES loyalty_conditions(id) ON DELETE SET NULL,
  condition_name     text NOT NULL,                       -- snapshot (immutable audit)
  trigger            text NOT NULL,                       -- snapshot
  reward_type        text NOT NULL,                       -- snapshot
  reward_value       numeric(14,2) NOT NULL DEFAULT 0,    -- snapshot
  points_contributed integer NOT NULL DEFAULT 0,
  reward_product_ids jsonb,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_lca_order      ON loyalty_condition_applications (order_id);
CREATE INDEX idx_lca_condition  ON loyalty_condition_applications (condition_id, created_at DESC);
CREATE INDEX idx_lca_customer   ON loyalty_condition_applications (customer_id, created_at DESC);
-- A condition applies at most once per order (belt + braces on top of the
-- processed_keys tx idempotency guard in CreateOrder).
CREATE UNIQUE INDEX uq_lca_order_condition
  ON loyalty_condition_applications (order_id, condition_id);
```

- [ ] **Step 2: Build the backend to confirm the embed compiles**

Run: `cd backend && go build ./...`
Expected: success (the migration is embedded via `//go:embed migrations/*.sql`; not yet applied to any DB).

- [ ] **Step 3: Commit**

```bash
git add backend/internal/db/migrations/0032_loyalty_condition_applications.sql
git commit -m "feat(crm): SP-CRM-8 migration 0032 — loyalty_condition_applications audit table"
```

---

## Task 2: Pure evaluation engine + tests (TDD) — `service/loyalty.go`

**Files:**
- Create: `backend/internal/service/loyalty.go`
- Test: `backend/internal/service/loyalty_test.go`

- [ ] **Step 1: Write the failing tests**

```go
package service

import (
	"testing"
	"time"
)

// helper: a WIB date at noon (so .In(WIB) day math is unambiguous).
func wibDate(y int, m time.Month, d int) time.Time {
	return time.Date(y, m, d, 12, 0, 0, 0, time.FixedZone("WIB", 7*3600))
}
func fptr(f float64) *float64 { return &f }

func baseCtx() EvalContext {
	return EvalContext{
		Total: 50000, BasePoints: 50, ProductIDs: map[string]bool{"p1": true},
		SaleDate: wibDate(2026, 6, 6), // Sat 6 June 2026 → double_date (day 6 == month 6)
		Customer: EvalCustomer{VisitCount: 3},
	}
}

func TestEvaluate_NoConditions_ParityWithBase(t *testing.T) {
	o := EvaluateLoyalty(nil, baseCtx())
	if o.BestMultiplier != 1.0 || o.FlatBonus != 0 || len(o.Applied) != 0 {
		t.Fatalf("expected inert outcome, got %+v", o)
	}
	if got := o.FinalEarned(50); got != 50 {
		t.Fatalf("FinalEarned parity: want 50, got %d", got)
	}
}

func TestEvaluate_SpendingThreshold_SetPoints(t *testing.T) {
	conds := []LoyaltyCondition{{
		ID: "c1", Name: "Belanja 50rb", Type: "always_on", Trigger: "spending_threshold",
		RewardType: "set_points", RewardValue: 100, MinimumSpend: fptr(50000),
	}}
	o := EvaluateLoyalty(conds, baseCtx())
	if o.FlatBonus != 100 || o.BestMultiplier != 1.0 {
		t.Fatalf("want flat 100 ×1, got %+v", o)
	}
	if got := o.FinalEarned(50); got != 150 {
		t.Fatalf("want 150, got %d", got)
	}
	if len(o.Applied) != 1 || o.Applied[0].PointsContributed != 100 {
		t.Fatalf("applied attribution wrong: %+v", o.Applied)
	}
}

func TestEvaluate_BestMultiplier_NoCompound(t *testing.T) {
	conds := []LoyaltyCondition{
		{ID: "m2", Name: "x2", Type: "always_on", Trigger: "double_date", RewardType: "multiply_points", RewardValue: 2},
		{ID: "m3", Name: "x3", Type: "always_on", Trigger: "spending_threshold", RewardType: "multiply_points", RewardValue: 3, MinimumSpend: fptr(50000)},
	}
	o := EvaluateLoyalty(conds, baseCtx())
	if o.BestMultiplier != 3 {
		t.Fatalf("want best ×3 (no compound), got %v", o.BestMultiplier)
	}
	if got := o.FinalEarned(50); got != 150 { // round(50*3)+0
		t.Fatalf("want 150, got %d", got)
	}
	// winner (m3) records 100 (150-50); loser (m2) records 0.
	var winner, loser int
	for _, a := range o.Applied {
		if a.ConditionID == "m3" {
			winner = a.PointsContributed
		}
		if a.ConditionID == "m2" {
			loser = a.PointsContributed
		}
	}
	if winner != 100 || loser != 0 {
		t.Fatalf("attribution: winner=%d loser=%d", winner, loser)
	}
}

func TestEvaluate_MultiplierThenFlatBonus(t *testing.T) {
	conds := []LoyaltyCondition{
		{ID: "m", Name: "x2", Type: "always_on", Trigger: "double_date", RewardType: "multiply_points", RewardValue: 2},
		{ID: "s", Name: "+30", Type: "always_on", Trigger: "double_date", RewardType: "set_points", RewardValue: 30},
	}
	o := EvaluateLoyalty(conds, baseCtx())
	if got := o.FinalEarned(50); got != 130 { // round(50*2)+30
		t.Fatalf("want 130, got %d", got)
	}
}

func TestEvaluate_RewardValueZeroIgnored(t *testing.T) {
	conds := []LoyaltyCondition{
		{ID: "z", Name: "x0", Type: "always_on", Trigger: "double_date", RewardType: "multiply_points", RewardValue: 0},
		{ID: "n", Name: "-5", Type: "always_on", Trigger: "double_date", RewardType: "set_points", RewardValue: -5},
	}
	o := EvaluateLoyalty(conds, baseCtx())
	if o.BestMultiplier != 1.0 || o.FlatBonus != 0 {
		t.Fatalf("zero/negative reward_value must be ignored, got %+v", o)
	}
}

func TestEvaluate_Birthday_ExactMMDD(t *testing.T) {
	bday := time.Date(1990, 6, 6, 0, 0, 0, 0, time.UTC)
	ctx := baseCtx()
	ctx.Customer = EvalCustomer{VisitCount: 1, Birthday: &bday}
	conds := []LoyaltyCondition{{ID: "b", Name: "Ultah", Type: "always_on", Trigger: "birthday", RewardType: "set_points", RewardValue: 200}}
	if o := EvaluateLoyalty(conds, ctx); o.FlatBonus != 200 {
		t.Fatalf("birthday match expected, got %+v", o)
	}
	// Non-birthday day → no match.
	ctx.SaleDate = wibDate(2026, 7, 1)
	if o := EvaluateLoyalty(conds, ctx); o.FlatBonus != 0 {
		t.Fatalf("non-birthday must not match, got %+v", o)
	}
}

func TestEvaluate_FirstRegistration_OnlyVisitZero(t *testing.T) {
	conds := []LoyaltyCondition{{ID: "fr", Name: "Welcome", Type: "always_on", Trigger: "first_registration", RewardType: "set_points", RewardValue: 500}}
	ctx := baseCtx()
	ctx.Customer = EvalCustomer{VisitCount: 0}
	if o := EvaluateLoyalty(conds, ctx); o.FlatBonus != 500 {
		t.Fatalf("first registration should fire at visit 0, got %+v", o)
	}
	ctx.Customer = EvalCustomer{VisitCount: 1}
	if o := EvaluateLoyalty(conds, ctx); o.FlatBonus != 0 {
		t.Fatalf("should not fire after first visit, got %+v", o)
	}
}

func TestEvaluate_MemberDay_Weekday(t *testing.T) {
	// 2026-06-06 is a Saturday (weekday 6).
	conds := []LoyaltyCondition{{ID: "md", Name: "Sabtu", Type: "always_on", Trigger: "member_day", RewardType: "set_points", RewardValue: 25, ActiveDays: []int{6}}}
	if o := EvaluateLoyalty(conds, baseCtx()); o.FlatBonus != 25 {
		t.Fatalf("member_day Saturday should match, got %+v", o)
	}
	conds[0].ActiveDays = []int{1} // Monday only
	if o := EvaluateLoyalty(conds, baseCtx()); o.FlatBonus != 0 {
		t.Fatalf("member_day Monday should not match Saturday, got %+v", o)
	}
}

func TestEvaluate_ProductPurchase_Intersection(t *testing.T) {
	conds := []LoyaltyCondition{{ID: "pp", Name: "Beli p1", Type: "always_on", Trigger: "product_purchase", RewardType: "set_points", RewardValue: 40, ApplicableProductIDs: []string{"p1", "p9"}}}
	if o := EvaluateLoyalty(conds, baseCtx()); o.FlatBonus != 40 {
		t.Fatalf("product_purchase should match p1, got %+v", o)
	}
	conds[0].ApplicableProductIDs = []string{"p9"}
	if o := EvaluateLoyalty(conds, baseCtx()); o.FlatBonus != 0 {
		t.Fatalf("product_purchase should not match, got %+v", o)
	}
}

func TestEvaluate_CampaignWindow_InclusiveEdges(t *testing.T) {
	start := time.Date(2026, 6, 6, 0, 0, 0, 0, time.UTC)
	end := time.Date(2026, 6, 6, 0, 0, 0, 0, time.UTC)
	conds := []LoyaltyCondition{{ID: "cm", Name: "Hari ini", Type: "campaign", Trigger: "double_date", RewardType: "set_points", RewardValue: 10, CampaignStartDate: &start, CampaignEndDate: &end}}
	if o := EvaluateLoyalty(conds, baseCtx()); o.FlatBonus != 10 {
		t.Fatalf("campaign on the edge day should match, got %+v", o)
	}
	out := baseCtx()
	out.SaleDate = wibDate(2026, 6, 7) // day 7 ≠ month 6, and outside window anyway
	if o := EvaluateLoyalty(conds, out); o.FlatBonus != 0 {
		t.Fatalf("outside campaign must not match, got %+v", o)
	}
}

func TestEvaluate_InactiveSkipped(t *testing.T) {
	// loadActiveConditions only returns active rows, but guard anyway if IsActive present.
	conds := []LoyaltyCondition{{ID: "x", Name: "off", Type: "always_on", Trigger: "double_date", RewardType: "set_points", RewardValue: 99, IsActive: false}}
	if o := EvaluateLoyalty(conds, baseCtx()); o.FlatBonus != 0 {
		t.Fatalf("inactive condition must not fire, got %+v", o)
	}
}

func TestEvaluate_WIBMidnightBoundary(t *testing.T) {
	// 2026-06-05 22:00Z == 2026-06-06 05:00 WIB → must evaluate as June 6 (double_date).
	utcInstant := time.Date(2026, 6, 5, 22, 0, 0, 0, time.UTC)
	ctx := baseCtx()
	ctx.SaleDate = utcInstant.In(time.FixedZone("WIB", 7*3600))
	conds := []LoyaltyCondition{{ID: "dd", Name: "DoubleDate", Type: "always_on", Trigger: "double_date", RewardType: "set_points", RewardValue: 60}}
	if o := EvaluateLoyalty(conds, ctx); o.FlatBonus != 60 {
		t.Fatalf("WIB-day June 6 double_date should match, got %+v", o)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail (no engine yet)**

Run: `cd backend && go test ./internal/service/ -run TestEvaluate -v`
Expected: compile failure (`EvalContext`, `EvaluateLoyalty`, etc. undefined).

- [ ] **Step 3: Write the engine**

```go
package service

import (
	"math"
	"strconv"
	"time"
)

// LoyaltyCondition is the order-time view of a loyalty_conditions row, scanned by
// loadActiveConditions (order.go). Pure Go — no DB types — so the engine is testable.
type LoyaltyCondition struct {
	ID, Name, Type, Trigger, RewardType string
	RewardValue          float64
	RewardProductIDs     []string
	CampaignStartDate    *time.Time // date-only; nil for always_on
	CampaignEndDate      *time.Time
	ActiveDays           []int // weekday indices, Sunday=0 (matches time.Weekday + JS getDay)
	ApplicableProductIDs []string
	MinimumSpend         *float64
	IsActive             bool
}

// EvalCustomer is the loyalty-relevant slice of the order's customer (loaded under
// the FOR UPDATE row lock in CreateOrder).
type EvalCustomer struct {
	Birthday    *time.Time
	Anniversary *time.Time
	VisitCount  int
}

// EvalContext is everything the engine needs to decide matches for one order.
type EvalContext struct {
	Total      float64         // res.Total (pre-redemption)
	BasePoints int             // res.EarnedPoints — flat base, used for multiply attribution
	ProductIDs map[string]bool // set of order item product IDs
	SaleDate   time.Time       // already converted to WIB by the caller
	Customer   EvalCustomer
}

// AppliedCondition records one matched condition for the audit table.
type AppliedCondition struct {
	ConditionID, Name, Trigger, RewardType string
	RewardValue       float64
	RewardProductIDs  []string
	PointsContributed int // reporting attribution (0 for product_reward / non-winning multiply)
}

// LoyaltyOutcome is the engine result. FinalEarned(base) computes the order's points.
type LoyaltyOutcome struct {
	BestMultiplier float64
	FlatBonus      int
	Applied        []AppliedCondition
}

// FinalEarned folds the outcome over a base: round(base × bestMultiplier) + flatBonus.
func (o LoyaltyOutcome) FinalEarned(base int) int {
	return int(math.Round(float64(base)*o.BestMultiplier)) + o.FlatBonus
}

func dateOnly(t time.Time) time.Time {
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC)
}

func mmddEqual(a, b time.Time) bool {
	return a.Month() == b.Month() && a.Day() == b.Day()
}

// matches reports whether one condition fires for this order.
func (c LoyaltyCondition) matches(ctx EvalContext) bool {
	if !c.IsActive {
		return false
	}
	// Date window for campaigns (inclusive, date-only). always_on ignores dates.
	if c.Type == "campaign" {
		if c.CampaignStartDate == nil || c.CampaignEndDate == nil {
			return false
		}
		d := dateOnly(ctx.SaleDate)
		if d.Before(dateOnly(*c.CampaignStartDate)) || d.After(dateOnly(*c.CampaignEndDate)) {
			return false
		}
	}
	switch c.Trigger {
	case "first_registration":
		return ctx.Customer.VisitCount == 0
	case "birthday":
		return ctx.Customer.Birthday != nil && mmddEqual(*ctx.Customer.Birthday, ctx.SaleDate)
	case "anniversary":
		return ctx.Customer.Anniversary != nil && mmddEqual(*ctx.Customer.Anniversary, ctx.SaleDate)
	case "double_date":
		return ctx.SaleDate.Day() == int(ctx.SaleDate.Month())
	case "member_day":
		wd := int(ctx.SaleDate.Weekday())
		for _, d := range c.ActiveDays {
			if d == wd {
				return true
			}
		}
		return false
	case "product_purchase":
		if len(c.ApplicableProductIDs) == 0 {
			return false
		}
		for _, pid := range c.ApplicableProductIDs {
			if ctx.ProductIDs[pid] {
				return true
			}
		}
		return false
	case "spending_threshold":
		return c.MinimumSpend != nil && ctx.Total >= *c.MinimumSpend
	}
	return false
}

// EvaluateLoyalty folds all matching conditions into a multiplier + flat bonus +
// applied list. conds is expected ordered (created_at, id) so multiply-tie
// attribution is deterministic. Conditions with reward_value <= 0 are ignored.
func EvaluateLoyalty(conds []LoyaltyCondition, ctx EvalContext) LoyaltyOutcome {
	out := LoyaltyOutcome{BestMultiplier: 1.0}

	// First pass: find the single highest positive multiplier among matches. On a tie
	// the first in input order (created_at, id) wins → deterministic across replays.
	// A deliberate fractional multiplier (0 < v < 1) is respected if it's the only one.
	bestIdx := -1
	for i, c := range conds {
		if c.RewardType != "multiply_points" || c.RewardValue <= 0 || !c.matches(ctx) {
			continue
		}
		if bestIdx == -1 || c.RewardValue > conds[bestIdx].RewardValue {
			bestIdx = i
		}
	}
	if bestIdx != -1 {
		out.BestMultiplier = conds[bestIdx].RewardValue
	}
	winnerDelta := int(math.Round(float64(ctx.BasePoints)*out.BestMultiplier)) - ctx.BasePoints

	// Second pass: build Applied + flat bonus, in input order.
	for i, c := range conds {
		if !c.matches(ctx) {
			continue
		}
		switch c.RewardType {
		case "set_points":
			if c.RewardValue <= 0 {
				continue
			}
			bonus := int(math.Round(c.RewardValue))
			out.FlatBonus += bonus
			out.Applied = append(out.Applied, AppliedCondition{
				ConditionID: c.ID, Name: c.Name, Trigger: c.Trigger, RewardType: c.RewardType,
				RewardValue: c.RewardValue, PointsContributed: bonus,
			})
		case "multiply_points":
			if c.RewardValue <= 0 {
				continue
			}
			pc := 0
			if i == bestIdx {
				pc = winnerDelta
			}
			out.Applied = append(out.Applied, AppliedCondition{
				ConditionID: c.ID, Name: c.Name, Trigger: c.Trigger, RewardType: c.RewardType,
				RewardValue: c.RewardValue, PointsContributed: pc,
			})
		case "product_reward":
			out.Applied = append(out.Applied, AppliedCondition{
				ConditionID: c.ID, Name: c.Name, Trigger: c.Trigger, RewardType: c.RewardType,
				RewardValue: c.RewardValue, RewardProductIDs: c.RewardProductIDs,
			})
		}
	}
	return out
}

// LoyaltyEarnReason builds the human-readable ledger reason for the earn entry.
func LoyaltyEarnReason(orderNumber string, base int, o LoyaltyOutcome) string {
	if o.BestMultiplier == 1.0 && o.FlatBonus == 0 {
		return "Poin dari transaksi " + orderNumber
	}
	parts := "dasar " + itoa(base)
	if o.BestMultiplier != 1.0 {
		parts += " ×" + ftoa(o.BestMultiplier)
	}
	for _, a := range o.Applied {
		if a.RewardType == "set_points" {
			parts += " + " + a.Name + " +" + itoa(a.PointsContributed)
		}
	}
	return "Poin transaksi " + orderNumber + " (" + parts + ")"
}
```

Add the small local formatters at the bottom of `loyalty.go` (`strconv` is already in the import block above):

```go
func itoa(i int) string    { return strconv.Itoa(i) }
func ftoa(f float64) string { return strconv.FormatFloat(f, 'g', -1, 64) } // 2.0 → "2", 0.5 → "0.5"
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && go test ./internal/service/ -run TestEvaluate -v`
Expected: PASS (all `TestEvaluate_*`).

- [ ] **Step 5: Add a LoyaltyEarnReason test**

Append to `loyalty_test.go`:

```go
func TestLoyaltyEarnReason(t *testing.T) {
	if got := LoyaltyEarnReason("MDK-1", 50, LoyaltyOutcome{BestMultiplier: 1.0}); got != "Poin dari transaksi MDK-1" {
		t.Fatalf("plain reason wrong: %q", got)
	}
	o := LoyaltyOutcome{BestMultiplier: 2, FlatBonus: 100, Applied: []AppliedCondition{
		{Name: "Ulang Tahun", RewardType: "set_points", PointsContributed: 100},
	}}
	want := "Poin transaksi MDK-1 (dasar 50 ×2 + Ulang Tahun +100)"
	if got := LoyaltyEarnReason("MDK-1", 50, o); got != want {
		t.Fatalf("breakdown reason: want %q got %q", want, got)
	}
}
```

Run: `cd backend && go test ./internal/service/ -run TestLoyaltyEarnReason -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/internal/service/loyalty.go backend/internal/service/loyalty_test.go
git commit -m "feat(crm): SP-CRM-8 pure loyalty-condition evaluation engine (TDD)"
```

---

## Task 3: Write helper + tx read — `InsertConditionApplication` and `loadActiveConditions`

**Files:**
- Create: `backend/internal/write/loyalty.go`
- Modify: `backend/internal/service/order.go` (add `loadActiveConditions`)

- [ ] **Step 1: Write `InsertConditionApplication`**

Create `backend/internal/write/loyalty.go`:

```go
package write

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// ConditionApplicationRow is one loyalty_condition_applications insert. Empty
// ConditionID encodes NULL (condition deleted between eval and write is impossible
// inside one tx, but the column is nullable for later ON DELETE SET NULL).
type ConditionApplicationRow struct {
	OrderID, CustomerID, ConditionID string
	ConditionName, Trigger, RewardType string
	RewardValue       float64
	PointsContributed int
	RewardProductIDs  []string
}

// InsertConditionApplication appends one audit row inside the given order tx.
func InsertConditionApplication(ctx context.Context, tx pgx.Tx, a ConditionApplicationRow) error {
	var rpids string
	if len(a.RewardProductIDs) > 0 {
		b, err := json.Marshal(a.RewardProductIDs)
		if err != nil {
			return fmt.Errorf("marshal reward product ids: %w", err)
		}
		rpids = string(b)
	}
	_, err := tx.Exec(ctx,
		`INSERT INTO loyalty_condition_applications
		   (order_id, customer_id, condition_id, condition_name, trigger, reward_type,
		    reward_value, points_contributed, reward_product_ids)
		 VALUES ($1,$2,NULLIF($3,'')::uuid,$4,$5,$6,$7,$8,NULLIF($9,'')::jsonb)`,
		a.OrderID, a.CustomerID, a.ConditionID, a.ConditionName, a.Trigger, a.RewardType,
		a.RewardValue, a.PointsContributed, rpids)
	if err != nil {
		return fmt.Errorf("insert condition application: %w", err)
	}
	return nil
}
```

- [ ] **Step 2: Add `loadActiveConditions` to `order.go`**

Add this function near `loadLoyalty` (after it, around `order.go:481`):

```go
// loadActiveConditions reads the active loyalty_conditions inside the order tx into
// the pure engine struct. Ordered (created_at, id) so multiply-tie attribution is
// deterministic. jsonb arrays scan directly into Go slices (pgx v5), as in resolvePromo.
func loadActiveConditions(ctx context.Context, tx pgx.Tx) ([]LoyaltyCondition, error) {
	rows, err := tx.Query(ctx, `
		SELECT id, name, type, trigger, reward_type, reward_value,
		       COALESCE(reward_product_ids,'[]'::jsonb),
		       campaign_start_date, campaign_end_date,
		       COALESCE(active_days,'[]'::jsonb),
		       COALESCE(applicable_product_ids,'[]'::jsonb),
		       minimum_spend, is_active
		  FROM loyalty_conditions
		 WHERE is_active = true
		 ORDER BY created_at, id`)
	if err != nil {
		return nil, fmt.Errorf("load loyalty conditions: %w", err)
	}
	defer rows.Close()
	var out []LoyaltyCondition
	for rows.Next() {
		var c LoyaltyCondition
		if err := rows.Scan(&c.ID, &c.Name, &c.Type, &c.Trigger, &c.RewardType, &c.RewardValue,
			&c.RewardProductIDs, &c.CampaignStartDate, &c.CampaignEndDate,
			&c.ActiveDays, &c.ApplicableProductIDs, &c.MinimumSpend, &c.IsActive); err != nil {
			return nil, fmt.Errorf("scan loyalty condition: %w", err)
		}
		out = append(out, c)
	}
	return out, rows.Err()
}
```

- [ ] **Step 3: Build**

Run: `cd backend && go build ./...`
Expected: success. (No call site yet for either — Task 4 wires them. `go build` tolerates the unused exported function `InsertConditionApplication` and the unexported `loadActiveConditions` only if referenced; an unreferenced unexported func is a compile-OK in Go as long as it's package-level — yes, package-level unused functions do NOT error, unlike unused locals/imports.)

- [ ] **Step 4: Commit**

```bash
git add backend/internal/write/loyalty.go backend/internal/service/order.go
git commit -m "feat(crm): SP-CRM-8 loyalty_condition_applications write helper + active-conditions tx read"
```

---

# BATCH B — Wire the engine into the hot path

## Task 4: Wire `EvaluateLoyalty` into `CreateOrder`

**Files:**
- Modify: `backend/internal/service/order.go:118-292` (the Compute → customer-lock → ledger region)

- [ ] **Step 1: Add the WIB zone var**

Near the top of `order.go` (after the `var ( ErrNoItems … )` block, ~line 20), add:

```go
// wib is the fixed Indonesia business zone (UTC+7, no DST) used to evaluate
// date-dependent loyalty triggers against the order's sale moment.
var wib = time.FixedZone("WIB", 7*3600)
```

- [ ] **Step 2: Expand the customer FOR UPDATE select to load birthday/anniversary/visit_count**

Replace the lock block at `order.go:133-140`:

```go
	balanceBefore := 0
	if hasLoyaltyCustomer {
		if e := tx.QueryRow(ctx,
			`SELECT points FROM customers WHERE id=$1 FOR UPDATE`,
			in.CustomerID).Scan(&balanceBefore); e != nil {
			return "", false, false, fmt.Errorf("load customer points: %w", e)
		}
	}
```

with:

```go
	balanceBefore := 0
	var evalCust EvalCustomer
	if hasLoyaltyCustomer {
		if e := tx.QueryRow(ctx,
			`SELECT points, birthday, anniversary, visit_count
			   FROM customers WHERE id=$1 FOR UPDATE`,
			in.CustomerID).Scan(&balanceBefore, &evalCust.Birthday, &evalCust.Anniversary, &evalCust.VisitCount); e != nil {
			return "", false, false, fmt.Errorf("load customer points: %w", e)
		}
	}
```

- [ ] **Step 3: Compute finalEarned via the engine (after the redemption block, before stock loop)**

`res.EarnedPoints` is the base. Immediately after `finalTotal := res.Total - redeemAmount` (`order.go:154`), insert:

```go
	// Loyalty-condition engine (SP-CRM-8): base × bestMultiplier + Σ set_points.
	// Inert when no condition matches → finalEarned == base (byte-identical to before).
	base := res.EarnedPoints
	finalEarned := base
	var outcome LoyaltyOutcome
	if hasLoyaltyCustomer {
		conds, e := loadActiveConditions(ctx, tx)
		if e != nil {
			return "", false, false, e
		}
		pidSet := make(map[string]bool, len(in.Items))
		for _, it := range in.Items {
			pidSet[it.ProductID] = true
		}
		saleTime := time.Now()
		if in.ClientCreated != nil {
			saleTime = *in.ClientCreated
		}
		outcome = EvaluateLoyalty(conds, EvalContext{
			Total: res.Total, BasePoints: base, ProductIDs: pidSet,
			SaleDate: saleTime.In(wib), Customer: evalCust,
		})
		finalEarned = outcome.FinalEarned(base)
	}
```

- [ ] **Step 4: Replace `res.EarnedPoints` at the order insert + customer update with `finalEarned`**

At `order.go:240` the order INSERT passes `res.EarnedPoints,` for `points_earned` → change to `finalEarned,`.

At `order.go:259-262` the customer update uses `res.EarnedPoints`:

```go
		UPDATE customers SET total_spent=total_spent+$1, visit_count=visit_count+1,
		  last_visit=now(), points=points+$2-$4 WHERE id=$3`,
		finalTotal, res.EarnedPoints, in.CustomerID, pointsRedeemed); e != nil {
```

change `res.EarnedPoints` → `finalEarned`.

- [ ] **Step 5: Use finalEarned + breakdown reason in the earn ledger entry, and write application rows**

Replace the earn-ledger block at `order.go:270-292` (the `if hasLoyaltyCustomer { … }` containing earn/redeem) so the earn entry uses `finalEarned` + `LoyaltyEarnReason`, and append the application-row writes. New block:

```go
		if hasLoyaltyCustomer {
			earned := finalEarned
			if earned > 0 {
				if e := write.InsertPointTx(ctx, tx, write.PointTxRow{
					CustomerID: in.CustomerID, Type: "earn", Points: earned,
					BalanceAfter: balanceBefore + earned,
					Reason:       LoyaltyEarnReason(orderNumber, base, outcome),
					OrderID:      orderID, ByID: in.CashierID, ByName: in.CashierName,
				}); e != nil {
					return "", false, false, fmt.Errorf("ledger earn: %w", e)
				}
			}
			if pointsRedeemed > 0 {
				if e := write.InsertPointTx(ctx, tx, write.PointTxRow{
					CustomerID: in.CustomerID, Type: "redeem", Points: -pointsRedeemed,
					BalanceAfter: balanceBefore + earned - pointsRedeemed,
					Reason:       fmt.Sprintf("Penukaran poin di transaksi %s", orderNumber),
					OrderID:      orderID, ByID: in.CashierID, ByName: in.CashierName,
				}); e != nil {
					return "", false, false, fmt.Errorf("ledger redeem: %w", e)
				}
			}
			// Audit: one row per matched condition (set/multiply/product_reward).
			for _, a := range outcome.Applied {
				if e := write.InsertConditionApplication(ctx, tx, write.ConditionApplicationRow{
					OrderID: orderID, CustomerID: in.CustomerID, ConditionID: a.ConditionID,
					ConditionName: a.Name, Trigger: a.Trigger, RewardType: a.RewardType,
					RewardValue: a.RewardValue, PointsContributed: a.PointsContributed,
					RewardProductIDs: a.RewardProductIDs,
				}); e != nil {
					return "", false, false, fmt.Errorf("record condition application: %w", e)
				}
			}
		}
```

> The original code read `earned := res.EarnedPoints`; we now use `finalEarned`. The `balanceBefore + earned` arithmetic and the redeem entry are otherwise unchanged.

- [ ] **Step 6: Build + run the full service test suite**

Run: `cd backend && go build ./... && go test ./internal/service/ ./internal/write/ -v`
Expected: PASS (engine tests + existing order/points tests). No `-race` locally.

- [ ] **Step 7: Commit**

```bash
git add backend/internal/service/order.go
git commit -m "feat(crm): SP-CRM-8 wire loyalty engine into CreateOrder — variable earned points + applications + breakdown reason"
```

---

## Task 5: Refund regression guard (no production code change)

**Files:**
- Modify: `backend/internal/service/order.go` (comment only) — and rely on existing clawback.

The spec confirms refund needs no points change: it already claws back `orders.points_earned`, which now stores `finalEarned`. This task only documents that and adds a focused note so a future reader does not "fix" it.

- [ ] **Step 1: Add a clarifying comment at the refund points block**

At `order.go:377` (the `// Points reversal (SP-CRM-7)…` comment), append a sentence:

```go
	// Points reversal (SP-CRM-7): claw back earned (floor 0, forgive remainder) and
	// restore redeemed. Idempotent: the already-refunded short-circuit above means
	// this runs at most once per order.
	// SP-CRM-8: orders.points_earned now stores the FULL engine total (base × mult +
	// bonuses), so this clawback reverses bonuses too with no change here. Condition
	// application rows are immutable order-time facts and are intentionally not reversed.
```

- [ ] **Step 2: Build**

Run: `cd backend && go build ./...`
Expected: success.

- [ ] **Step 3: Commit**

```bash
git add backend/internal/service/order.go
git commit -m "docs(crm): SP-CRM-8 note refund clawback covers engine bonuses (no code change)"
```

---

# BATCH C — API surface (OpenAPI + read + handler + route + TS client)

## Task 6: OpenAPI — `appliedCount` + `RewardGrant` + reward-grants path, then regenerate

**Files:**
- Modify: `backend/api/openapi.yaml`
- Regenerate: `backend/internal/api/api.gen.go`, `packages/api/src/schema.d.ts`

- [ ] **Step 1: Add `appliedCount` to `LoyaltyCondition` (OPTIONAL — keep `CondForm` happy)**

In `openapi.yaml` `LoyaltyCondition` (line ~859), add to `properties` (NOT to `required`):

```yaml
        appliedCount: { type: integer, nullable: true }
```

- [ ] **Step 2: Add the `RewardGrant` + list response schemas**

After `LoyaltyConditionListResponse` (line ~881), add:

```yaml
    RewardGrant:
      type: object
      required: [id, conditionName, rewardProductIds, orderId, createdAt]
      properties:
        id: { type: string, format: uuid }
        conditionName: { type: string }
        rewardProductIds: { type: array, items: { type: string } }
        orderId: { type: string, format: uuid, nullable: true }
        orderNumber: { type: string, nullable: true }
        createdAt: { type: string, format: date-time }
    RewardGrantListResponse:
      type: object
      required: [data]
      properties:
        data: { type: array, items: { $ref: '#/components/schemas/RewardGrant' } }
```

- [ ] **Step 3: Add the path**

After the `/api/v1/customers/{id}/points/adjust` block (line ~2185), add:

```yaml
  /api/v1/customers/{id}/reward-grants:
    get:
      operationId: listRewardGrants
      tags: [customers]
      summary: Customer product-reward grants (Backoffice, SP-CRM-8)
      parameters:
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
      responses:
        '200':
          description: reward grants
          content:
            application/json:
              schema: { $ref: '#/components/schemas/RewardGrantListResponse' }
```

- [ ] **Step 4: Regenerate Go + TS types**

Run:
```bash
cd backend && go tool oapi-codegen -config api/oapi-codegen.yaml api/openapi.yaml
cd .. && corepack pnpm --filter @mandalika/api gen
```
Expected: `backend/internal/api/api.gen.go` now has `RewardGrant`, `RewardGrantListResponse`, `AppliedCount *int` on `LoyaltyCondition`; `packages/api/src/schema.d.ts` updated.

- [ ] **Step 5: Verify gen + build**

Run: `cd backend && go build ./... && make gen-check`
Expected: build OK; `make gen-check` clean (api.gen.go matches the spec).

- [ ] **Step 6: Commit**

```bash
git add backend/api/openapi.yaml backend/internal/api/api.gen.go packages/api/src/schema.d.ts
git commit -m "feat(crm): SP-CRM-8 OpenAPI — appliedCount + reward-grants endpoint (regen)"
```

---

## Task 7: Backend read + handler + route — reward grants & appliedCount

**Files:**
- Modify: `backend/internal/read/repo.go` (add `RewardGrants`; add `appliedCount` to `LoyaltyConditions`)
- Modify: `backend/internal/handlers/writes.go` (add `RewardGrants` handler)
- Modify: `backend/internal/server/server.go` (register the route)

- [ ] **Step 1: Add `appliedCount` to the `LoyaltyConditions` read**

In `repo.go:834-843`, extend the `json_build_object` with a correlated count. Replace the SELECT body's object with:

```go
	return listJSON[api.LoyaltyCondition](ctx, r.Pool,
		`SELECT json_build_object('id',id,'name',name,'type',type,'trigger',trigger,
		   'rewardType',reward_type,'rewardValue',reward_value,
		   'rewardProductIds',reward_product_ids,
		   'campaignStartDate',campaign_start_date,'campaignEndDate',campaign_end_date,
		   'activeDays',active_days,'applicableProductIds',applicable_product_ids,
		   'minimumSpend',minimum_spend,'isActive',is_active,'createdAt',created_at,
		   'appliedCount',(SELECT count(*) FROM loyalty_condition_applications a
		                     WHERE a.condition_id = loyalty_conditions.id))
		   FROM loyalty_conditions ORDER BY created_at DESC`)
```

- [ ] **Step 2: Add the `RewardGrants` read**

After `PointTransactions` (`repo.go:788`), add:

```go
// RewardGrants lists a customer's product_reward grants (SP-CRM-8), newest first.
func (r *Repo) RewardGrants(ctx context.Context, customerID string) ([]api.RewardGrant, error) {
	const sql = `SELECT json_build_object(
		  'id', a.id, 'conditionName', a.condition_name,
		  'rewardProductIds', COALESCE(a.reward_product_ids,'[]'::jsonb),
		  'orderId', a.order_id, 'orderNumber', o.order_number, 'createdAt', a.created_at)
		FROM loyalty_condition_applications a
		LEFT JOIN orders o ON o.id = a.order_id
		WHERE a.customer_id = $1 AND a.reward_type = 'product_reward'
		ORDER BY a.created_at DESC, a.id DESC`
	rows, _, err := listJSON[api.RewardGrant](ctx, r.Pool, sql, customerID)
	return rows, err
}
```

- [ ] **Step 3: Add the handler**

In `handlers/writes.go`, after `AdjustPoints` (`~line 626`), add:

```go
func (h *Handlers) RewardGrants(w http.ResponseWriter, r *http.Request) {
	rows, err := h.Repo.RewardGrants(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, http.StatusOK, api.RewardGrantListResponse{Data: rows})
}
```

- [ ] **Step 4: Register the route**

In `server.go`, inside the `manage_customers` group (after `r.Get("/customers/{id}/points", h.PointTransactions)`, line ~171), add:

```go
				r.Get("/customers/{id}/reward-grants", h.RewardGrants)
```

- [ ] **Step 5: Build**

Run: `cd backend && go build ./... && go vet ./internal/read/ ./internal/handlers/ ./internal/server/`
Expected: success.

- [ ] **Step 6: Commit**

```bash
git add backend/internal/read/repo.go backend/internal/handlers/writes.go backend/internal/server/server.go
git commit -m "feat(crm): SP-CRM-8 backend — appliedCount on conditions + reward-grants read/handler/route"
```

---

## Task 8: TS client — `listRewardGrants`

**Files:**
- Modify: `packages/api/src/client.ts`

- [ ] **Step 1: Add the interface method**

In `client.ts`, after `adjustPoints` (line ~186) in the interface, add:

```ts
  listRewardGrants: (customerId: string) => Promise<RewardGrant[]>
```

Add `RewardGrant` to the type imports at the top of `client.ts` (the `import type { … } from './schema'`-style block — follow the existing import of `PointTransaction`).

- [ ] **Step 2: Add the implementation**

After the `adjustPoints` impl (line ~474), add:

```ts
    listRewardGrants: (customerId) =>
      data<RewardGrant[]>('GET', `${API}/customers/${customerId}/reward-grants`),
```

- [ ] **Step 3: Typecheck the package**

Run: `corepack pnpm --filter @mandalika/api build` (or `pnpm --filter @mandalika/api typecheck` if defined)
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/client.ts
git commit -m "feat(crm): SP-CRM-8 TS client — listRewardGrants"
```

---

# BATCH D — Backoffice

## Task 9: Fix the pre-existing `loyaltyForm` clobber bug

**Files:**
- Modify: `apps/backoffice/src/screens/Customers.tsx`

- [ ] **Step 1: Seed `loyaltyForm` from `lq.data` when it loads**

`loyaltyForm` is `useState(DEFAULT_LOYALTY)` (`Customers.tsx:151`) and never synced. Add a `useEffect` right after the `loyaltyForm` state declaration:

```tsx
  useEffect(() => {
    if (lq.data) setLoyaltyForm(lq.data)
  }, [lq.data])
```

Ensure `useEffect` is imported from `react` at the top of the file (add to the existing `import { useState, … } from 'react'`).

- [ ] **Step 2: Simplify `saveLoyalty` (no more tierEnabled workaround)**

`saveLoyalty` (`Customers.tsx:197-201`) currently patches `tierEnabled` from the server because the form was stale. With the form now seeded from `lq.data` (which includes `tierEnabled`), replace:

```tsx
      await api.updateLoyaltySettings({ ...loyaltyForm, tierEnabled: loyalty.tierEnabled })
```

with:

```tsx
      await api.updateLoyaltySettings(loyaltyForm)
```

- [ ] **Step 3: Typecheck + build the backoffice**

Run: `corepack pnpm --filter @mandalika/backoffice exec tsc -b && corepack pnpm --filter @mandalika/backoffice build`
Expected: clean (no unused `loyalty` var error — `loyalty` is still used elsewhere for the `Nilai aktif:` line at `Customers.tsx:335`).

- [ ] **Step 4: Commit**

```bash
git add apps/backoffice/src/screens/Customers.tsx
git commit -m "fix(crm): SP-CRM-8 sync loyaltyForm from server (stop clobbering untouched loyalty settings)"
```

---

## Task 10: "Terpakai: N" on the condition list

**Files:**
- Modify: `apps/backoffice/src/screens/Customers.tsx:358-361`

- [ ] **Step 1: Render the applied count next to the trigger→reward summary**

The condition row summary is at `Customers.tsx:358-361`. After the `</p>` that shows the trigger→reward label, add a count line (only when present):

```tsx
                          {typeof c.appliedCount === 'number' && c.appliedCount > 0 && (
                            <p className="text-xs text-gray-400">Terpakai: {c.appliedCount}×</p>
                          )}
```

(`appliedCount` is now on the generated `LoyaltyCondition` type from Task 6.)

- [ ] **Step 2: Typecheck + build**

Run: `corepack pnpm --filter @mandalika/backoffice exec tsc -b && corepack pnpm --filter @mandalika/backoffice build`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add apps/backoffice/src/screens/Customers.tsx
git commit -m "feat(crm): SP-CRM-8 show per-condition Terpakai count in backoffice"
```

---

## Task 11: Reward-grants list on `CustomerDetail`

**Files:**
- Create: `apps/backoffice/src/screens/customers/rewardTypes.ts`
- Modify: `apps/backoffice/src/screens/customers/CustomerDetail.tsx`

- [ ] **Step 1: Create the helper (mirror `pointTypes.ts`)**

`apps/backoffice/src/screens/customers/rewardTypes.ts`:

```ts
// SP-CRM-8: render product-reward grants. Product names aren't on the grant (it
// stores product IDs); show the count + ids until a future slice joins names.
export function rewardGrantSummary(productIds: string[]): string {
  const n = productIds.length
  if (n === 0) return 'Reward produk'
  return `${n} produk gratis`
}
```

- [ ] **Step 2: Fetch reward grants in `CustomerDetail`**

Near the points-ledger query (`CustomerDetail.tsx:111`), add a sibling query:

```tsx
  const rgq = usePolledQuery(
    () => api.listRewardGrants(customerId),
    [customerId],
  )
  const rewardGrants = rgq.data ?? []
```

- [ ] **Step 3: Render a small "Reward Produk" block inside the Poin card**

In the Poin `Card` (the `{/* Poin ledger (SP-CRM-7) */}` block starting `CustomerDetail.tsx:361`), after the ledger list, add a conditional section:

```tsx
              {rewardGrants.length > 0 && (
                <div className="border-t border-gray-100 px-4 py-3">
                  <p className="text-xs font-bold text-gray-500 mb-2">Reward Produk</p>
                  <ul className="space-y-1">
                    {rewardGrants.map((g) => (
                      <li key={g.id} className="flex items-center justify-between text-xs">
                        <span className="font-semibold text-gray-700">{g.conditionName}</span>
                        <span className="text-gray-400">
                          {rewardGrantSummary(g.rewardProductIds)}
                          {g.orderNumber ? ` · ${g.orderNumber}` : ''}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
```

Add the import at the top of `CustomerDetail.tsx` (near the `pointTypes` import at line 21):

```tsx
import { rewardGrantSummary } from './rewardTypes'
```

- [ ] **Step 4: Typecheck + build**

Run: `corepack pnpm --filter @mandalika/backoffice exec tsc -b && corepack pnpm --filter @mandalika/backoffice build`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add apps/backoffice/src/screens/customers/rewardTypes.ts apps/backoffice/src/screens/customers/CustomerDetail.tsx
git commit -m "feat(crm): SP-CRM-8 show customer product-reward grants on detail"
```

---

# BATCH E — Verification & rollout

## Task 12: DB structure check (throwaway, tx rolled back)

**Files:**
- Create (then delete): `backend/cmd/sp8dbcheck/main.go`

- [ ] **Step 1: Write the throwaway checker**

It connects with `DATABASE_URL`, opens a tx, asserts the table + 4 indexes (3 plain + 1 unique) exist, and that the UNIQUE `(order_id, condition_id)` rejects a duplicate; then ROLLS BACK. Use the pattern from prior `cmd/*` checkers (pgx, `tx.Rollback`). Key assertions:

```go
// inside a tx that is always rolled back:
// 1. table exists:
//    SELECT to_regclass('loyalty_condition_applications')  -> not null
// 2. indexes exist:
//    SELECT count(*) FROM pg_indexes WHERE tablename='loyalty_condition_applications'  -> >= 4
// 3. unique works: insert two rows with same (order_id, condition_id) using a real
//    order_id + customer_id + condition_id pulled from existing rows (or skip insert
//    if none exist — assert the index is UNIQUE via pg_index.indisunique instead).
```

Prefer the **catalog assertion** for the unique (no inserts needed, zero pollution risk):

```sql
SELECT indisunique FROM pg_index i
  JOIN pg_class c ON c.oid = i.indexrelid
  WHERE c.relname = 'uq_lca_order_condition'  -- expect true
```

- [ ] **Step 2: Run it against prod DB (read-only / rolled back)**

Run (PowerShell, secret via gcloud substitution; never print):
```powershell
$env:DATABASE_URL = (gcloud secrets versions access latest --secret=DATABASE_URL)
cd backend; go run ./cmd/sp8dbcheck
```
Expected: prints all checks PASS. No rows written (tx rolled back / catalog-only).

- [ ] **Step 3: Delete the throwaway + commit nothing for it**

```bash
git rm -r --cached backend/cmd/sp8dbcheck 2>$null; Remove-Item -Recurse -Force backend/cmd/sp8dbcheck
```
(The throwaway is never committed.)

---

## Task 13: Deploy + live e2e (real OrderService, toggle loyalty on→off, full cleanup)

**Files:**
- Create (then delete): `backend/cmd/sp8e2e/main.go`

- [ ] **Step 1: Deploy the backend (applies migration 0032 on boot)**

```bash
gcloud run deploy mandalika-pos --source backend --region asia-southeast2 --quiet
```
Then: `curl -fsS https://<service-url>/readyz` → expect `ok`. Capture the new revision (e.g. `00056-xxx`).

- [ ] **Step 2: Write the e2e (mirror `cmd/crm7e2e`)**

The e2e must, in a throwaway connected with `DATABASE_URL`:
1. `defer` restore `loyalty_settings.enabled=false` (and set it again explicitly at the end).
2. Set `loyalty_settings.enabled=true` (points_per_thousand=1 already configured).
3. Seed a temp customer with `birthday = today (WIB) MM-DD` and `visit_count=0`.
4. Seed temp conditions: a `set_points` (+100, trigger=birthday), a `multiply_points` (×2, trigger=double_date OR member_day matching today), and a `product_reward` (trigger=spending_threshold min=1).
5. Call the REAL `service.NewOrderService(pool).CreateOrder(...)` with a total that yields a known base (e.g. total 50000 → base 50), `ClientCreated = now`, the temp customer, one item.
6. Assert: `orders.points_earned == round(50×2)+100 == 200`; exactly one `earn` ledger row with `balance_after == 200` and the breakdown reason; application rows present (1 per matched condition) with correct `points_contributed` (winner multiply = 50, set = 100, product_reward = 0); the product_reward grant row has `reward_product_ids`.
7. **Replay** the same `IdempotencyKey` → assert no second earn row, no duplicate applications (unique index holds), `points_earned` unchanged.
8. Refund the order → assert clawback reverses the full 200 (floor-0) via the existing path.
9. DELETE everything created (loyalty_condition_applications, point_transactions, order_items, processed_keys, orders, the temp conditions, the temp customer); confirm `loyalty_settings.enabled` is back to `false`.

- [ ] **Step 3: Run the e2e**

```powershell
$env:DATABASE_URL = (gcloud secrets versions access latest --secret=DATABASE_URL)
cd backend; go run ./cmd/sp8e2e
```
Expected: all assertions PASS; final line confirms loyalty back OFF + all artifacts deleted.

- [ ] **Step 4: Delete the throwaway**

```powershell
Remove-Item -Recurse -Force backend/cmd/sp8e2e
```
(Never committed.)

- [ ] **Step 5: Authed live smoke (optional, read-only)**

With `SEED_ADMIN_PASSWORD` (login `admin@mandalika.test`), hit `GET /api/v1/loyalty-conditions` → confirm `appliedCount` field present (0 after cleanup); `GET /api/v1/customers/{id}/reward-grants` for any customer → 200 array (empty). Token at `resp.data.access`.

---

## Task 14: Final verification + docs

- [ ] **Step 1: Full backend test + gen-check**

Run: `cd backend && go build ./... && go test ./... && make gen-check`
Expected: PASS / clean. (No `-race` locally; CI runs race.)

- [ ] **Step 2: Full frontend build**

Run: `corepack pnpm -r build` (or the per-app `tsc -b && vite build` for `@mandalika/api`, `@mandalika/backoffice`)
Expected: clean.

- [ ] **Step 3: Update `SESSION_HANDOFF.md`**

Add a new `⭐ LATEST SESSION — 2026-06-10 (SP-CRM-8 …)` section at the top documenting: migration 0032, the engine, the wiring, the backoffice changes, the deployed revision, the e2e result, and USER-PENDING visual walkthroughs. Refresh the COPY-READY block to point at SP-CRM-Merge / the deferred product_reward-fulfillment POS slice as next.

- [ ] **Step 4: Commit docs**

```bash
git add SESSION_HANDOFF.md
git commit -m "docs: SP-CRM-8 done — loyalty trigger engine wired into earning path (mig 0032, rev <rev>)"
```

- [ ] **Step 5: Push**

```bash
git push
```
(Retry on "Connection was reset" — tethered-network transient.)

- [ ] **Step 6: Update memory**

Update the `crm-customers-module` memory file: SP-CRM-8 DONE (engine wired, mig 0032, rev, e2e proven, loyalty still OFF in prod so engine dormant); next = SP-CRM-Merge + the deferred product_reward POS-fulfillment slice.

---

## Self-Review notes (addressed)

- **Spec coverage:** migration 0032 (Unit 5 → T1); pure engine + all 7 triggers + 3 rewards + stacking + WIB + reward_value≤0 + no-match parity (Unit 1 → T2); read/write helpers (Units 2/3 → T3); CreateOrder wiring + finalEarned + applications + breakdown reason (Unit 3 → T4); refund no-op (Unit 4 → T5); OpenAPI/appliedCount/reward-grants (Unit 6 → T6); read/handler/route (T7); TS client (T8); loyaltyForm fix (T9); Terpakai count (T10); reward-grants UI (T11); DB + e2e verification (T12/T13); docs/memory (T14).
- **Placeholder scan:** the two throwaway checkers (T12/T13) describe exact assertions + the catalog SQL rather than full `main.go` bodies — intentional (they mirror the committed-then-deleted `cmd/crm7e2e`/`explaincheck` pattern and are never committed); all production code steps carry complete code.
- **Type consistency:** `EvaluateLoyalty`/`EvalContext`/`EvalCustomer`/`LoyaltyOutcome`/`AppliedCondition`/`LoyaltyCondition` (service) and `ConditionApplicationRow` (write) names match across T2/T3/T4; `appliedCount` (optional) and `RewardGrant`/`RewardGrantListResponse` match across T6/T7/T8/T10/T11; `loadActiveConditions` ordered `(created_at, id)` matches the engine's tie-break assumption.
