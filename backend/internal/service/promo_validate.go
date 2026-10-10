package service

import (
	"github.com/mandalika/pos-backend/internal/apperr"
	"strings"
	"time"
)

// PromoViolation is a single failed gating rule. Stable string codes — they are
// joined into orders.discount_warning_reason and mapped to UI messages.
type PromoViolation string

const (
	ViolationNotStarted    PromoViolation = "not_started"
	ViolationExpired       PromoViolation = "expired"
	ViolationBelowMin      PromoViolation = "below_min_purchase"
	ViolationWrongDay      PromoViolation = "wrong_day"
	ViolationOutsideHours  PromoViolation = "outside_hours"
	ViolationWrongOutlet   PromoViolation = "wrong_outlet"
	ViolationUsageLimit    PromoViolation = "usage_limit_reached"
	ViolationNotFound      PromoViolation = "not_found"
	ViolationNotCombinable PromoViolation = "not_combinable"
	ViolationCodeOnly      PromoViolation = "code_only" // promo applied directly but is reachable only via a linked code
	// SP-Promo-3b reward fulfillment: a reward (buy_x_get_y free/discounted) line is
	// not on the promo's get-set, or exceeds the cart's earned reward quota.
	ViolationRewardInvalid PromoViolation = "reward_invalid"
	// SP-Promo-3b-bundle: a bundle-freed line is not slot-eligible, no complete set
	// exists, a slot is over-freed, or a cheaper eligible unit was left paid.
	ViolationBundleInvalid PromoViolation = "bundle_invalid"
	// SP-Code-3: a per-customer-capped code needs a registered customer on the order;
	// and the chosen customer has hit that code's per-customer usage cap (T3 enforces).
	ViolationRequiresCustomer      PromoViolation = "requires_customer"
	ViolationPerCustomerCapReached PromoViolation = "per_customer_cap_reached"
	// SP-Code-4: a customer-assigned code requires the order's chosen customer to match.
	ViolationWrongCustomer PromoViolation = "wrong_customer"
)

// PromoEvalContext is the order-time situation a promo/code is validated against.
type PromoEvalContext struct {
	SaleTimeWIB time.Time // already in the wib zone
	OutletID    string
	Subtotal    float64 // pre-discount sum of line subtotals
	HasCustomer bool
	CustomerID  string
}

// PromoRow / CodeRow are the loaded gating columns (nil/empty = no constraint).
type PromoRow struct {
	StartDate, EndDate           *time.Time
	MinPurchase                  *float64
	ActiveFromHour, ActiveToHour string
	ActiveDays                   []int // 0=Sun..6=Sat (matches Go time.Weekday)
	OutletIDs                    []string
	Combinable                   bool
}
type CodeRow struct {
	StartDate, EndDate *time.Time
	MinPurchase        *float64
	UsageLimit         *int
	UsageCount         int
	Combinable         bool
	PerCustomerLimit   *int
	CustomerID         *string
}

// ErrDiscountRejected is returned for an INVALID discount on an ONLINE order so
// the caller maps it to an HTTP 422. Offline orders never produce this (lenient).
type ErrDiscountRejected struct{ Violations []PromoViolation }

// ErrorCode marks a rejected discount as a business refusal on /sync/batch.
func (e *ErrDiscountRejected) ErrorCode() apperr.Code { return apperr.Rejected }

func (e *ErrDiscountRejected) Error() string {
	return "discount rejected: " + JoinViolations(e.Violations)
}

func JoinViolations(v []PromoViolation) string {
	s := make([]string, len(v))
	for i := range v {
		s[i] = string(v[i])
	}
	return strings.Join(s, ",")
}

// promoDateOnly normalizes any instant to a date-only value stamped in the fixed
// WIB business zone, so a WIB sale time and a UTC-midnight `date` column (how pgx
// returns DATE) compare purely by calendar date. (Distinct from loyalty.go's
// dateOnly, which stamps UTC for birthday/anniversary math.)
func promoDateOnly(t time.Time) time.Time {
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, wib)
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
	d := promoDateOnly(ec.SaleTimeWIB)
	if p.StartDate != nil && d.Before(promoDateOnly(*p.StartDate)) {
		v = append(v, ViolationNotStarted)
	}
	if p.EndDate != nil && d.After(promoDateOnly(*p.EndDate)) {
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
	d := promoDateOnly(ec.SaleTimeWIB)
	if c.StartDate != nil && d.Before(promoDateOnly(*c.StartDate)) {
		v = append(v, ViolationNotStarted)
	}
	if c.EndDate != nil && d.After(promoDateOnly(*c.EndDate)) {
		v = append(v, ViolationExpired)
	}
	if c.MinPurchase != nil && ec.Subtotal < *c.MinPurchase {
		v = append(v, ViolationBelowMin)
	}
	// usage_limit of 0 means UNLIMITED (backoffice shows it as ∞), so only enforce > 0.
	if c.UsageLimit != nil && *c.UsageLimit > 0 && c.UsageCount >= *c.UsageLimit {
		v = append(v, ViolationUsageLimit)
	}
	if c.PerCustomerLimit != nil && !ec.HasCustomer {
		v = append(v, ViolationRequiresCustomer)
	}
	if c.CustomerID != nil && (!ec.HasCustomer || *c.CustomerID != ec.CustomerID) {
		v = append(v, ViolationWrongCustomer)
	}
	return v
}
