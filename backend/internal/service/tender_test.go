package service

import (
	"errors"
	"testing"
)

func TestEvaluateTender(t *testing.T) {
	cases := []struct {
		name          string
		method        string
		captured, due float64
		paid, change  float64
		reason        string
	}{
		{"cash exact", "cash", 100000, 100000, 100000, 0, ""},
		{"cash over gives change", "cash", 150000, 100000, 150000, 50000, ""},
		{"cash short", "cash", 90000, 100000, 90000, 0, TenderCashShort},
		{"cash exactly due minus Rp1 passes", "cash", 99999, 100000, 99999, 0, ""},
		{"cash 99998.99 is short", "cash", 99998.99, 100000, 99998.99, 0, TenderCashShort},
		{"cash zero total any amount", "cash", 5000, 0, 5000, 5000, ""},
		{"cash zero total zero", "cash", 0, 0, 0, 0, ""},
		{"noncash exact", "qris", 100000, 100000, 100000, 0, ""},
		{"noncash within Rp1 under", "qris", 99999, 100000, 99999, 0, ""},
		{"noncash within Rp1 over", "qris", 100001, 100000, 100001, 0, ""},
		{"noncash under", "qris", 95000, 100000, 95000, 0, TenderNoncashMismatch},
		{"noncash over", "qris", 120000, 100000, 120000, 0, TenderNoncashMismatch},
		{"custom method missing amount", "bca", 0, 100000, 0, 0, TenderNoncashMismatch},
		{"noncash zero total zero", "qris", 0, 0, 0, 0, ""},
		{"noncash zero total positive", "qris", 1000, 0, 1000, 0, TenderNoncashMismatch},
		{"method match is exact", "Cash", 90000, 100000, 90000, 0, TenderNoncashMismatch},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			paid, change, reason := evaluateTender(c.method, c.captured, c.due)
			if paid != c.paid || change != c.change || reason != c.reason {
				t.Fatalf("got paid=%v change=%v reason=%q", paid, change, reason)
			}
		})
	}
}

func TestTenderRejectedIsRejectedError(t *testing.T) {
	if err := tenderRejectedError(1, 2); !errors.Is(err, ErrTenderRejected) {
		t.Fatal("must wrap ErrTenderRejected")
	}
}
