package handlers

import (
	"testing"

	"github.com/mandalika/pos-backend/internal/service"
)

func TestDiscountRejectMessage(t *testing.T) {
	tests := []struct {
		name string
		in   []service.PromoViolation
		want string
	}{
		{"empty", nil, "Diskon tidak berlaku"},
		{"expired", []service.PromoViolation{service.ViolationExpired}, "Kode/promo sudah kadaluarsa"},
		{"not started", []service.PromoViolation{service.ViolationNotStarted}, "Promo belum dimulai"},
		{"below min", []service.PromoViolation{service.ViolationBelowMin}, "Belum memenuhi minimum belanja"},
		{"outside hours", []service.PromoViolation{service.ViolationOutsideHours}, "Promo tidak berlaku pada jam ini"},
		{"wrong day", []service.PromoViolation{service.ViolationWrongDay}, "Promo tidak berlaku hari ini"},
		{"wrong outlet", []service.PromoViolation{service.ViolationWrongOutlet}, "Promo tidak berlaku di outlet ini"},
		{"usage limit", []service.PromoViolation{service.ViolationUsageLimit}, "Kuota kode diskon sudah habis"},
		{"not found", []service.PromoViolation{service.ViolationNotFound}, "Diskon tidak ditemukan"},
		{"first violation wins", []service.PromoViolation{service.ViolationExpired, service.ViolationBelowMin}, "Kode/promo sudah kadaluarsa"},
		{"unknown falls back", []service.PromoViolation{service.PromoViolation("bogus")}, "Diskon tidak berlaku"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := discountRejectMessage(tt.in); got != tt.want {
				t.Errorf("got %q want %q", got, tt.want)
			}
		})
	}
}
