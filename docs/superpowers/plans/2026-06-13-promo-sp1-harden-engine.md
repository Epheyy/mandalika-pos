# SP-Promo-1 — Harden the Promotion Engine · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce the promotion/discount-code rules that are already stored but ignored at checkout (usage limits race-safely, dates, min purchase, hours/days/outlets), restore usage on refund, and flag offline-applied invalid discounts — without breaking the offline-first sale path.

**Architecture:** A pure, table-tested validator (`service/promo_validate.go`, EvaluateLoyalty-style, no DB import) decides which rules a loaded promo/code row violates. `resolvePromo` is widened to load the full gating columns, run the validator, and apply a **hybrid-by-origin** policy: invalid + online → reject (HTTP 422); invalid + offline → apply the server-authoritative discount value anyway (record as the cashier rang it) and set a persisted `discount_warning` flag. Refund decrements `usage_count` (floor 0). A minimal backoffice badge surfaces the flag.

**Tech Stack:** Go (pgx, chi), Postgres (numbered SQL migrations auto-applied on deploy), OpenAPI → `oapi-codegen` + `@mandalika/api` codegen, React/TS backoffice (Vite).

**Spec:** `docs/superpowers/specs/2026-06-13-promo-sp1-harden-engine-design.md`

**Review routing (per model-routing-policy):** Tasks 1–5 + 7 touch the hot order/pricing/money path → **Opus** review. Task 6 (OpenAPI + read projection + backoffice badge) → typescript-reviewer (+ go-reviewer for the read query).

---

## File structure

| File | Responsibility | Action |
|---|---|---|
| `backend/internal/db/migrations/0035_order_discount_warning.sql` | `orders.discount_warning` + `discount_warning_reason` columns | Create |
| `backend/internal/service/promo_validate.go` | Pure validator: violation types, `ValidatePromo`, `ValidateCode`, `ErrDiscountRejected` | Create |
| `backend/internal/service/promo_validate_test.go` | Table-driven unit tests for the validator | Create |
| `backend/internal/service/order.go` | Widen `resolvePromo`; precompute subtotal + eval context; persist warning; refund usage restore | Modify |
| `backend/internal/handlers/writes.go` | Map `ErrDiscountRejected` → HTTP 422 with Indonesian message | Modify |
| `backend/api/openapi.yaml` | Add `discountWarning`/`discountWarningReason` to the `Order` read schema | Modify |
| `backend/internal/read/repo.go` | Add the two fields to the `orderObj` JSON projection | Modify |
| `apps/backoffice/src/screens/Orders.tsx` | Read-only `⚠ Diskon` badge on flagged orders | Modify |
| `backend/cmd/promo1e2e/main.go` | Throwaway live e2e (online reject / offline flag / refund restore / race) | Create then delete |

---

## Task 1: Migration 0035 — discount_warning columns

**Files:**
- Create: `backend/internal/db/migrations/0035_order_discount_warning.sql`

- [ ] **Step 1: Write the migration**

```sql
-- SP-Promo-1: flag an order whose applied discount violated a stored rule but was
-- accepted anyway because the sale arrived via the offline sync path (cash already
-- collected). Mirrors stock_warning (0002): record reality, flag for reconciliation.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_warning        boolean NOT NULL DEFAULT false;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_warning_reason text;
```

- [ ] **Step 2: Verify it builds (migrations are embedded)**

Run: `cd backend && go build ./...`
Expected: builds clean (the embed.FS picks up the new file; it auto-applies on deploy/boot like 0033/0034).

- [ ] **Step 3: Commit**

```bash
git add backend/internal/db/migrations/0035_order_discount_warning.sql
git commit -m "feat(promo): migration 0035 — orders.discount_warning + reason (SP-Promo-1)"
```

---

## Task 2: Pure validator + tests (TDD)

**Files:**
- Create: `backend/internal/service/promo_validate.go`
- Test: `backend/internal/service/promo_validate_test.go`

- [ ] **Step 1: Write the failing tests**

```go
package service

import (
	"testing"
	"time"
)

// 2026-06-13 is a Saturday (Weekday 6). 14:30 WIB.
func ctxAt(y int, m time.Month, d, hh, mm int, subtotal float64, outlet string) PromoEvalContext {
	t := time.Date(y, m, d, hh, mm, 0, 0, wib)
	return PromoEvalContext{SaleTimeWIB: t, OutletID: outlet, Subtotal: subtotal}
}
func dptr(y int, m time.Month, d int) *time.Time { t := time.Date(y, m, d, 0, 0, 0, 0, wib); return &t }
func fptr(f float64) *float64                    { return &f }
func iptr(i int) *int                            { return &i }

func TestValidatePromo(t *testing.T) {
	base := ctxAt(2026, 6, 13, 14, 30, 100000, "outlet-a") // Saturday
	tests := []struct {
		name string
		row  PromoRow
		ctx  PromoEvalContext
		want []PromoViolation
	}{
		{"all empty passes", PromoRow{}, base, nil},
		{"not started", PromoRow{StartDate: dptr(2026, 6, 20)}, base, []PromoViolation{ViolationNotStarted}},
		{"expired", PromoRow{EndDate: dptr(2026, 6, 1)}, base, []PromoViolation{ViolationExpired}},
		{"date window inclusive ok", PromoRow{StartDate: dptr(2026, 6, 13), EndDate: dptr(2026, 6, 13)}, base, nil},
		{"below min", PromoRow{MinPurchase: fptr(150000)}, base, []PromoViolation{ViolationBelowMin}},
		{"min exact ok", PromoRow{MinPurchase: fptr(100000)}, base, nil},
		{"wrong day", PromoRow{ActiveDays: []int{1, 2, 3}}, base, []PromoViolation{ViolationWrongDay}},
		{"right day ok", PromoRow{ActiveDays: []int{6}}, base, nil},
		{"outside hours", PromoRow{ActiveFromHour: "09:00", ActiveToHour: "12:00"}, base, []PromoViolation{ViolationOutsideHours}},
		{"inside hours ok", PromoRow{ActiveFromHour: "09:00", ActiveToHour: "17:00"}, base, nil},
		{"hour boundary inclusive", PromoRow{ActiveFromHour: "14:30", ActiveToHour: "14:30"}, base, nil},
		{"only one hour set = no gate", PromoRow{ActiveFromHour: "09:00"}, base, nil},
		{"wrong outlet", PromoRow{OutletIDs: []string{"outlet-b"}}, base, []PromoViolation{ViolationWrongOutlet}},
		{"right outlet ok", PromoRow{OutletIDs: []string{"outlet-a", "outlet-b"}}, base, nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ValidatePromo(tt.row, tt.ctx)
			if !sameViolations(got, tt.want) {
				t.Errorf("got %v want %v", got, tt.want)
			}
		})
	}
}

func TestValidateCode(t *testing.T) {
	base := ctxAt(2026, 6, 13, 14, 30, 100000, "outlet-a")
	tests := []struct {
		name string
		row  CodeRow
		ctx  PromoEvalContext
		want []PromoViolation
	}{
		{"all empty passes", CodeRow{}, base, nil},
		{"expired", CodeRow{EndDate: dptr(2026, 6, 1)}, base, []PromoViolation{ViolationExpired}},
		{"below min", CodeRow{MinPurchase: fptr(150000)}, base, []PromoViolation{ViolationBelowMin}},
		{"usage limit reached", CodeRow{UsageLimit: iptr(2), UsageCount: 2}, base, []PromoViolation{ViolationUsageLimit}},
		{"usage under limit ok", CodeRow{UsageLimit: iptr(2), UsageCount: 1}, base, nil},
		{"usage limit zero = unlimited", CodeRow{UsageLimit: iptr(0), UsageCount: 99}, base, nil},
		{"nil limit = unlimited", CodeRow{UsageCount: 99}, base, nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ValidateCode(tt.row, tt.ctx)
			if !sameViolations(got, tt.want) {
				t.Errorf("got %v want %v", got, tt.want)
			}
		})
	}
}

func sameViolations(a, b []PromoViolation) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && go test ./internal/service/ -run 'TestValidatePromo|TestValidateCode'`
Expected: FAIL — undefined: `PromoEvalContext`, `PromoRow`, `ValidatePromo`, etc.

- [ ] **Step 3: Write the validator**

```go
package service

import (
	"strings"
	"time"
)

// PromoViolation is a single failed gating rule. Stable string codes — they are
// joined into orders.discount_warning_reason and mapped to UI messages.
type PromoViolation string

const (
	ViolationNotStarted   PromoViolation = "not_started"
	ViolationExpired      PromoViolation = "expired"
	ViolationBelowMin     PromoViolation = "below_min_purchase"
	ViolationWrongDay     PromoViolation = "wrong_day"
	ViolationOutsideHours PromoViolation = "outside_hours"
	ViolationWrongOutlet  PromoViolation = "wrong_outlet"
	ViolationUsageLimit   PromoViolation = "usage_limit_reached"
	ViolationNotFound     PromoViolation = "not_found"
)

// PromoEvalContext is the order-time situation a promo/code is validated against.
type PromoEvalContext struct {
	SaleTimeWIB time.Time // already in the wib zone
	OutletID    string
	Subtotal    float64 // pre-discount sum of line subtotals
}

// PromoRow / CodeRow are the loaded gating columns (nil/empty = no constraint).
type PromoRow struct {
	StartDate, EndDate           *time.Time
	MinPurchase                  *float64
	ActiveFromHour, ActiveToHour string
	ActiveDays                   []int // 0=Sun..6=Sat (matches Go time.Weekday)
	OutletIDs                    []string
}
type CodeRow struct {
	StartDate, EndDate *time.Time
	MinPurchase        *float64
	UsageLimit         *int
	UsageCount         int
}

// ErrDiscountRejected is returned for an INVALID discount on an ONLINE order so
// the caller maps it to an HTTP 422. Offline orders never produce this (lenient).
type ErrDiscountRejected struct{ Violations []PromoViolation }

func (e *ErrDiscountRejected) Error() string { return "discount rejected: " + JoinViolations(e.Violations) }

func JoinViolations(v []PromoViolation) string {
	s := make([]string, len(v))
	for i := range v {
		s[i] = string(v[i])
	}
	return strings.Join(s, ",")
}

func dateOnly(t time.Time) time.Time {
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, t.Location())
}
func containsInt(xs []int, x int) bool {
	for _, v := range xs {
		if v == x {
			return true
		}
	}
	return false
}
func containsStrV(xs []string, x string) bool {
	for _, v := range xs {
		if v == x {
			return true
		}
	}
	return false
}

func ValidatePromo(p PromoRow, ec PromoEvalContext) []PromoViolation {
	var v []PromoViolation
	d := dateOnly(ec.SaleTimeWIB)
	if p.StartDate != nil && d.Before(dateOnly(*p.StartDate)) {
		v = append(v, ViolationNotStarted)
	}
	if p.EndDate != nil && d.After(dateOnly(*p.EndDate)) {
		v = append(v, ViolationExpired)
	}
	if p.MinPurchase != nil && ec.Subtotal < *p.MinPurchase {
		v = append(v, ViolationBelowMin)
	}
	if len(p.ActiveDays) > 0 && !containsInt(p.ActiveDays, int(ec.SaleTimeWIB.Weekday())) {
		v = append(v, ViolationWrongDay)
	}
	// Both bounds required to gate (a half-set window is treated as no constraint),
	// mirroring the loyalty campaign "needs both dates" rule.
	if p.ActiveFromHour != "" && p.ActiveToHour != "" {
		hm := ec.SaleTimeWIB.Format("15:04")
		if hm < p.ActiveFromHour || hm > p.ActiveToHour {
			v = append(v, ViolationOutsideHours)
		}
	}
	if len(p.OutletIDs) > 0 && !containsStrV(p.OutletIDs, ec.OutletID) {
		v = append(v, ViolationWrongOutlet)
	}
	return v
}

func ValidateCode(c CodeRow, ec PromoEvalContext) []PromoViolation {
	var v []PromoViolation
	d := dateOnly(ec.SaleTimeWIB)
	if c.StartDate != nil && d.Before(dateOnly(*c.StartDate)) {
		v = append(v, ViolationNotStarted)
	}
	if c.EndDate != nil && d.After(dateOnly(*c.EndDate)) {
		v = append(v, ViolationExpired)
	}
	if c.MinPurchase != nil && ec.Subtotal < *c.MinPurchase {
		v = append(v, ViolationBelowMin)
	}
	// usage_limit of 0 means UNLIMITED (backoffice shows it as ∞), so only enforce > 0.
	if c.UsageLimit != nil && *c.UsageLimit > 0 && c.UsageCount >= *c.UsageLimit {
		v = append(v, ViolationUsageLimit)
	}
	return v
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && go test ./internal/service/ -run 'TestValidatePromo|TestValidateCode' -v`
Expected: PASS (all subtests).

- [ ] **Step 5: Commit**

```bash
git add backend/internal/service/promo_validate.go backend/internal/service/promo_validate_test.go
git commit -m "feat(promo): pure promo/code validator + tests (SP-Promo-1)"
```

---

## Task 3: Wire the validator into resolvePromo + CreateOrder

**Files:**
- Modify: `backend/internal/service/order.go` (resolvePromo `549-587`; CreateOrder `130-156`, `222-225`, INSERT `296-318`)

- [ ] **Step 1: Replace `resolvePromo` with the validating version**

Replace the whole function (`order.go:549-587`) with:

```go
// resolvePromo turns an applied promotion id and/or discount code into the
// authoritative PromoSpec, validating the stored gating rules (SP-Promo-1).
// Returns the discount_codes row id (for usage++) and a non-empty warnReason when
// an OFFLINE order applied an invalid discount (recorded + flagged). An INVALID
// discount on an ONLINE order returns *ErrDiscountRejected (caller → HTTP 422).
func (s *OrderService) resolvePromo(ctx context.Context, tx pgx.Tx, promoID, code string, ec PromoEvalContext, offline bool) (*PromoSpec, string, string, error) {
	if promoID != "" {
		var kind string
		var value float64
		var ids []string
		var row PromoRow
		err := tx.QueryRow(ctx,
			`SELECT type, value,
			   COALESCE(applicable_product_ids,'[]'::jsonb),
			   start_date, end_date, min_purchase,
			   active_from_hour, active_to_hour,
			   COALESCE(active_days,'[]'::jsonb), COALESCE(outlet_ids,'[]'::jsonb)
			   FROM promotions WHERE id=$1 AND is_active=true`, promoID).
			Scan(&kind, &value, &ids, &row.StartDate, &row.EndDate, &row.MinPurchase,
				&row.ActiveFromHour, &row.ActiveToHour, &row.ActiveDays, &row.OutletIDs)
		if errors.Is(err, pgx.ErrNoRows) {
			if !offline {
				return nil, "", "", &ErrDiscountRejected{Violations: []PromoViolation{ViolationNotFound}}
			}
			return nil, "", string(ViolationNotFound), nil // can't reconstruct value offline
		}
		if err != nil {
			return nil, "", "", fmt.Errorf("load promotion: %w", err)
		}
		spec := &PromoSpec{Kind: DiscountKind(kind), Value: value, ApplicableProductIDs: ids, IsBOGO: kind == "bogo"}
		if vio := ValidatePromo(row, ec); len(vio) > 0 {
			if !offline {
				return nil, "", "", &ErrDiscountRejected{Violations: vio}
			}
			return spec, "", JoinViolations(vio), nil // offline: apply authoritative value + flag
		}
		return spec, "", "", nil
	}
	if code != "" {
		var id, kind string
		var value float64
		var row CodeRow
		// FOR UPDATE: hold the row lock from validation through the usage_count++ at
		// the end of this same tx — makes the usage_limit check race-safe.
		err := tx.QueryRow(ctx,
			`SELECT id, type, value, start_date, end_date, min_purchase, usage_limit, usage_count
			   FROM discount_codes WHERE code=$1 AND is_active=true FOR UPDATE`, code).
			Scan(&id, &kind, &value, &row.StartDate, &row.EndDate, &row.MinPurchase, &row.UsageLimit, &row.UsageCount)
		if errors.Is(err, pgx.ErrNoRows) {
			if !offline {
				return nil, "", "", &ErrDiscountRejected{Violations: []PromoViolation{ViolationNotFound}}
			}
			return nil, "", string(ViolationNotFound), nil
		}
		if err != nil {
			return nil, "", "", fmt.Errorf("load discount code: %w", err)
		}
		spec := &PromoSpec{Kind: DiscountKind(kind), Value: value}
		if vio := ValidateCode(row, ec); len(vio) > 0 {
			if !offline {
				return nil, "", "", &ErrDiscountRejected{Violations: vio}
			}
			return spec, id, JoinViolations(vio), nil // offline: apply + flag; usage still increments (accurate)
		}
		return spec, id, "", nil
	}
	return nil, "", "", nil
}
```

- [ ] **Step 2: Precompute subtotal + eval context and hoist saleTime in CreateOrder**

In `CreateOrder`, replace the `resolvePromo` call block (`order.go:130-134`):

```go
	// Resolve promo spec server-side (authoritative value, not client-supplied).
	promo, promoCodeID, err := s.resolvePromo(ctx, tx, in.PromotionID, in.DiscountCode)
	if err != nil {
		return "", false, false, err
	}
```

with:

```go
	// SP-Promo-1: validate the applied discount against its stored rules. Subtotal
	// (pre-discount) is needed for min_purchase; saleTime (WIB) for date/hour/day
	// gating — hoisted here and reused by the loyalty engine below.
	var promoSubtotal float64
	for _, it := range in.Items {
		promoSubtotal += it.Subtotal
	}
	saleTime := time.Now()
	if in.ClientCreated != nil {
		saleTime = *in.ClientCreated
	}
	promoEvalCtx := PromoEvalContext{SaleTimeWIB: saleTime.In(wib), OutletID: in.OutletID, Subtotal: promoSubtotal}

	// Resolve promo spec server-side (authoritative value, not client-supplied).
	promo, promoCodeID, discountWarnReason, err := s.resolvePromo(ctx, tx, in.PromotionID, in.DiscountCode, promoEvalCtx, in.Offline)
	if err != nil {
		return "", false, false, err
	}
	discountWarning := discountWarnReason != ""
```

- [ ] **Step 3: Reuse the hoisted saleTime in the loyalty block**

In the loyalty block, replace (`order.go:222-225`):

```go
		saleTime := time.Now()
		if in.ClientCreated != nil {
			saleTime = *in.ClientCreated
		}
		outcome = EvaluateLoyalty(conds, EvalContext{
```

with (the variable is now declared above — drop the redeclaration):

```go
		outcome = EvaluateLoyalty(conds, EvalContext{
```

(`saleTime` is already in scope from Step 2; this removes a shadow and reuses the same value.)

- [ ] **Step 4: Persist the warning in the INSERT**

In the `INSERT INTO orders (...)` statement (`order.go:296-318`), add the two columns and params.

Change the column list tail `... discount_label, discount_breakdown, points_earned)` to:
`... discount_label, discount_breakdown, points_earned, discount_warning, discount_warning_reason)`

Change the VALUES tail `...$32::jsonb,$33)` to `...$32::jsonb,$33,$34,$35)`

Change the args tail (currently ending):
```go
		stockWarning, pointsRedeemed, nullStr(in.DiscountLabel), nullBytes(in.DiscountBreakdown),
		finalEarned,
	).Scan(&orderID)
```
to:
```go
		stockWarning, pointsRedeemed, nullStr(in.DiscountLabel), nullBytes(in.DiscountBreakdown),
		finalEarned, discountWarning, nullStr(discountWarnReason),
	).Scan(&orderID)
```

- [ ] **Step 5: Build + run the full service test suite**

Run: `cd backend && go build ./... && go test ./internal/service/`
Expected: PASS (existing pricing/loyalty tests unaffected; new validator tests pass). Pricing is byte-identical when all rules pass.

- [ ] **Step 6: Commit**

```bash
git add backend/internal/service/order.go
git commit -m "feat(promo): enforce promo/code rules at checkout, hybrid-by-origin (SP-Promo-1)"
```

---

## Task 4: Map ErrDiscountRejected → HTTP 422

**Files:**
- Modify: `backend/internal/handlers/writes.go` (CreateOrder handler `940-944`)

- [ ] **Step 1: Add the typed-error mapping**

In `CreateOrder` (`writes.go:940-944`), replace:

```go
	id, _, _, err := h.OrderSvc.CreateOrder(r.Context(), in)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
```

with:

```go
	id, _, _, err := h.OrderSvc.CreateOrder(r.Context(), in)
	if err != nil {
		var rej *service.ErrDiscountRejected
		if errors.As(err, &rej) {
			httpx.Err(w, http.StatusUnprocessableEntity, discountRejectMessage(rej.Violations))
			return
		}
		writeErr(w, http.StatusBadRequest, err)
		return
	}
```

- [ ] **Step 2: Add the message helper (same file, package-level)**

Add near the other helpers in `writes.go`:

```go
// discountRejectMessage turns the first promo violation into an Indonesian cashier
// message for an online-rejected discount (SP-Promo-1).
func discountRejectMessage(v []service.PromoViolation) string {
	if len(v) == 0 {
		return "Diskon tidak berlaku"
	}
	switch v[0] {
	case service.ViolationExpired:
		return "Kode/promo sudah kadaluarsa"
	case service.ViolationNotStarted:
		return "Promo belum dimulai"
	case service.ViolationBelowMin:
		return "Belum memenuhi minimum belanja"
	case service.ViolationOutsideHours:
		return "Promo tidak berlaku pada jam ini"
	case service.ViolationWrongDay:
		return "Promo tidak berlaku hari ini"
	case service.ViolationWrongOutlet:
		return "Promo tidak berlaku di outlet ini"
	case service.ViolationUsageLimit:
		return "Kuota kode diskon sudah habis"
	case service.ViolationNotFound:
		return "Diskon tidak ditemukan"
	default:
		return "Diskon tidak berlaku"
	}
}
```

- [ ] **Step 3: Ensure `errors` is imported**

Check the import block at the top of `writes.go`. If `"errors"` is not present, add it (goimports will place it).

Run: `cd backend && go build ./...`
Expected: builds clean. If `errors` was missing it now compiles; if `httpx`/`service` already imported (they are — used throughout the file), no change needed.

- [ ] **Step 4: Commit**

```bash
git add backend/internal/handlers/writes.go
git commit -m "feat(promo): online CreateOrder returns 422 on rejected discount (SP-Promo-1)"
```

---

## Task 5: Refund restores usage_count

**Files:**
- Modify: `backend/internal/service/order.go` (Refund `451-468`)

- [ ] **Step 1: Select the order's discount_code in the refund lock query**

Replace (`order.go:448-454`):

```go
	var status, orderNumber string
	var custID *string
	var oEarned, oRedeemed int
	err = tx.QueryRow(ctx,
		`SELECT status, order_number, customer_id, points_earned, points_redeemed
		   FROM orders WHERE id=$1 AND outlet_id=$2 FOR UPDATE`,
		orderID, outletID).Scan(&status, &orderNumber, &custID, &oEarned, &oRedeemed)
```

with:

```go
	var status, orderNumber string
	var custID *string
	var discountCode *string
	var oEarned, oRedeemed int
	err = tx.QueryRow(ctx,
		`SELECT status, order_number, customer_id, points_earned, points_redeemed, discount_code
		   FROM orders WHERE id=$1 AND outlet_id=$2 FOR UPDATE`,
		orderID, outletID).Scan(&status, &orderNumber, &custID, &oEarned, &oRedeemed, &discountCode)
```

- [ ] **Step 2: Decrement usage after the refund UPDATE**

Immediately after the `UPDATE orders SET status='refunded' ...` block (`order.go:464-468`), add:

```go
	// SP-Promo-1: restore the discount code's usage (floor 0). Idempotent — the
	// already-refunded short-circuit above means this runs at most once per order.
	if discountCode != nil && *discountCode != "" {
		if _, err = tx.Exec(ctx,
			`UPDATE discount_codes SET usage_count = GREATEST(usage_count - 1, 0) WHERE code=$1`,
			*discountCode); err != nil {
			return fmt.Errorf("restore discount usage: %w", err)
		}
	}
```

- [ ] **Step 3: Build + test**

Run: `cd backend && go build ./... && go test ./internal/service/`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add backend/internal/service/order.go
git commit -m "feat(promo): refund restores discount_code usage_count, floor 0 (SP-Promo-1)"
```

---

## Task 6: Surface the flag — OpenAPI + read projection + backoffice badge

**Files:**
- Modify: `backend/api/openapi.yaml` (Order schema, after `discountBreakdown` ~`1069-1072`)
- Modify: `backend/internal/read/repo.go` (`orderObj` `935-954`)
- Modify: `apps/backoffice/src/screens/Orders.tsx` (row header ~`173-177`)

- [ ] **Step 1: Add the fields to the OpenAPI `Order` schema**

In `openapi.yaml`, immediately after the `Order` schema's `discountBreakdown` block (the one near line 1069-1072, inside the read `Order` — NOT the `CreateOrderInput` near 1449), add:

```yaml
        discountWarning: { type: boolean }
        discountWarningReason: { type: string, nullable: true }
```

(`discountWarningReason` is a plain nullable string, not a `$ref`, so it is unaffected by the `$ref`+`nullable` codegen gotcha.)

- [ ] **Step 2: Regenerate API types**

Run:
```bash
cd backend && go tool oapi-codegen -config api/oapi-codegen.yaml api/openapi.yaml && corepack pnpm --filter @mandalika/api gen
```
Expected: `api.gen.go` gains `DiscountWarning`/`DiscountWarningReason` on `Order`; `schema.d.ts` gains `discountWarning`/`discountWarningReason`. Then:
Run: `cd backend && make gen-check`
Expected: clean (no drift).

- [ ] **Step 3: Add the fields to the `orderObj` projection**

In `read/repo.go`, in the `orderObj` constant, add to the projection (e.g. right after the `'discountBreakdown',o.discount_breakdown,` line at `942`):

```go
  'discountWarning',o.discount_warning,'discountWarningReason',o.discount_warning_reason,
```

- [ ] **Step 4: Build backend**

Run: `cd backend && go build ./... && go test ./internal/...`
Expected: PASS.

- [ ] **Step 5: Add the backoffice badge**

In `Orders.tsx`, in the row header status area (`173-177`), add the badge before the status `Badge`. Replace:

```tsx
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <Badge tone={badgeTone(o.status)}>{label(o.status)}</Badge>
```

with:

```tsx
                  <div className="flex items-center gap-3 flex-shrink-0">
                    {o.discountWarning && (
                      <span
                        title={o.discountWarningReason ?? undefined}
                        className="px-2 py-0.5 text-xs font-bold rounded-lg bg-amber-50 text-amber-700"
                      >
                        ⚠ Diskon
                      </span>
                    )}
                    <Badge tone={badgeTone(o.status)}>{label(o.status)}</Badge>
```

- [ ] **Step 6: Build backoffice**

Run: `cd apps/backoffice && pnpm tsc -b && pnpm vite build`
Expected: clean (the regenerated `@mandalika/api` types include the new fields).

- [ ] **Step 7: Commit**

```bash
git add backend/api/openapi.yaml backend/internal/handlers/api.gen.go packages/api apps/backoffice/src/screens/Orders.tsx backend/internal/read/repo.go
git commit -m "feat(promo): surface discount_warning — OpenAPI + read + backoffice badge (SP-Promo-1)"
```

(Adjust the `api.gen.go` path if codegen writes elsewhere; include whatever `make gen-check` tracks. If `pnpm-lock.yaml` changed, see the lockfile note in Verification.)

---

## Task 7: Live e2e + verification gate

**Files:**
- Create then delete: `backend/cmd/promo1e2e/main.go`

- [ ] **Step 1: Write the throwaway e2e**

A `main.go` that connects with `DATABASE_URL` (gcloud-secrets substitution), and against the real `service.OrderService` proves, each in a path that cleans up after itself (delete inserted orders/items/processed_keys, restore discount_codes.usage_count, delete the temp code):
1. Create a temp `discount_codes` row: `E2E-PROMO1`, fixed Rp10000, `usage_limit=1`, `is_active=true`, dates open.
2. **Online over-limit reject:** set `usage_count=1`; call `CreateOrder` with `Offline:false` + `DiscountCode:"E2E-PROMO1"` → expect `*service.ErrDiscountRejected` with `ViolationUsageLimit`; no order written.
3. **Offline over-limit flag:** same code, `Offline:true` → order succeeds, the row has `discount_warning=true`, `discount_warning_reason` contains `usage_limit_reached`, discount applied (total reflects −10000), `usage_count` incremented to 2.
4. **Refund restore:** refund that offline order → `usage_count` back to 1; refund again → still 1 (idempotent).
5. **Expired online reject:** temp code with `end_date` = yesterday, `usage_count=0` → `Offline:false` → `ErrDiscountRejected` `expired`.
6. **Valid passes:** open code, under limit, online → order succeeds, `discount_warning=false`.
7. **Cleanup:** delete all inserted orders/items/processed_keys + the temp codes; assert zero residue.

Print PASS/FAIL per assertion. (Model the connection + cleanup protocol on the prior `cmd/sp9e2e` / `cmd/spmergee2e` throwaways.)

- [ ] **Step 2: Run it**

Run: `cd backend && DATABASE_URL="$(gcloud secrets versions access latest --secret=DATABASE_URL)" go run ./cmd/promo1e2e`
Expected: all assertions PASS; cleanup zero-residue. (On a flaky first-write 400, re-run warm — Neon stale-connection transient.)

- [ ] **Step 3: Delete the throwaway**

```bash
rm -rf backend/cmd/promo1e2e
```

- [ ] **Step 4: Full local gate**

Run:
```bash
cd backend && go build ./... && go test ./... && make gen-check
cd ../apps/backoffice && pnpm tsc -b && pnpm vite build
```
Expected: all green, no codegen drift. (CI runs `go test -race` on Linux; the local Windows box can't `-race` — no cgo.)

- [ ] **Step 5: Deploy + verify (with migration 0035)**

```bash
gcloud run deploy mandalika-pos --source backend --region asia-southeast2 --quiet
```
Then verify: `/readyz` 200; authed smoke — create an online order with an expired code → **422** with the Indonesian message; GET an order list and confirm the new fields serialize. (Pull `SEED_ADMIN_PASSWORD` via gcloud-secrets command-substitution; admin email is `admin@mandalika.test`.)

- [ ] **Step 6: Confirm Cloudflare backoffice deploy is green**

The backoffice change auto-deploys on push. If `pnpm-lock.yaml` changed in Task 6, regenerate it first (`corepack pnpm@10.11.1 install --lockfile-only`, commit) so the Cloudflare frozen-lockfile build doesn't fail. Hard-refresh `mandalika-pos.pages.dev` → Transaksi → confirm flagged orders show the `⚠ Diskon` badge (none expected in clean test data; the e2e in Step 1 was cleaned up).

- [ ] **Step 7: Final commit (if any verification fixups)**

```bash
git add -A && git commit -m "chore(promo): SP-Promo-1 verification fixups"
```

---

## Self-review notes (author)

- **Spec coverage:** usage_limit race-safe (Task 3 `FOR UPDATE` + Task 2 rule); code dates/min (Task 2 `ValidateCode`); promo dates/min/hours/days/outlets (Task 2 `ValidatePromo`); hybrid reject/flag (Task 3 + Task 4); offline keep-as-rung at authoritative value (Task 3 offline branch returns `spec`); refund restoration (Task 5); migration (Task 1); badge (Task 6); tests/e2e (Task 2 + Task 7). All spec sections map to a task.
- **No tuple change:** `CreateOrder` return signature is unchanged — `discount_warning` is persisted internally and read back via `orderObj` (confirmed simpler than the spec's "extend tuple or struct" option; sync-result schema untouched).
- **Type consistency:** `PromoEvalContext`, `PromoRow`, `CodeRow`, `ValidatePromo`, `ValidateCode`, `ErrDiscountRejected`, `JoinViolations`, the `Violation*` constants, and `discountWarnReason`/`discountWarning` names are used identically across Tasks 2–4. `usage_limit==0 ⇒ unlimited` matches the backoffice `∞` display.
- **Out of scope (unchanged):** combinability, new types, code→promotion linkage, POS UX, analytics UI.
