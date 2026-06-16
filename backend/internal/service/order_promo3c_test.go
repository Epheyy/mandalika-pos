package service

import "testing"

func TestCombinedViolations(t *testing.T) {
	code := []PromoViolation{ViolationUsageLimit}
	promo := []PromoViolation{ViolationExpired}
	got := combinedViolations(code, promo)
	if len(got) != 2 || got[0] != ViolationUsageLimit || got[1] != ViolationExpired {
		t.Fatalf("want [usage_limit_reached expired], got %v", got)
	}
	if len(code) != 1 || len(promo) != 1 {
		t.Fatalf("inputs mutated: code=%v promo=%v", code, promo)
	}
}

func TestCombinedViolationsEmpty(t *testing.T) {
	if got := combinedViolations(nil, nil); len(got) != 0 {
		t.Fatalf("want empty, got %v", got)
	}
}
