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

// fptr is already declared in loyalty_test.go (same package); reuse it here.
func iptr(i int) *int { return &i }

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
	baseWithCustomer := base
	baseWithCustomer.HasCustomer = true
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
		{"requires customer (capped, no customer)", CodeRow{PerCustomerLimit: iptr(1)}, base, []PromoViolation{ViolationRequiresCustomer}},
		{"capped with customer ok", CodeRow{PerCustomerLimit: iptr(1)}, baseWithCustomer, nil},
		{"uncapped no customer ok", CodeRow{}, base, nil},
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
