package service

import "testing"

func TestCombinabilityGate(t *testing.T) {
	// >1 discount with any non-combinable -> violation.
	if v := combinabilityViolation([]bool{true, false}); v == nil {
		t.Fatal("expected violation for [combinable, non-combinable]")
	}
	// all combinable -> ok.
	if v := combinabilityViolation([]bool{true, true, true}); v != nil {
		t.Fatalf("expected no violation, got %v", *v)
	}
	// single discount is always fine, even if non-combinable.
	if v := combinabilityViolation([]bool{false}); v != nil {
		t.Fatalf("single discount must never gate, got %v", *v)
	}
	// zero discounts -> ok.
	if v := combinabilityViolation(nil); v != nil {
		t.Fatalf("no discounts must not gate, got %v", *v)
	}
}
