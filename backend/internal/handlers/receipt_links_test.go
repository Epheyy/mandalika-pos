package handlers

import (
	"testing"
	"time"

	"github.com/mandalika/pos-backend/internal/read"
)

func TestStoredPhoneAllowed(t *testing.T) {
	// 2026-11-27 23:30 UTC is already 28 Nov in WIB (UTC+7).
	now := time.Date(2026, 11, 27, 23, 30, 0, 0, time.UTC)
	order := func(outlet, day string) read.ReceiptOrder {
		return read.ReceiptOrder{OutletID: outlet, BusinessDate: day, Zone: "Asia/Jakarta"}
	}
	cases := []struct {
		name   string
		active string
		o      read.ReceiptOrder
		want   bool
	}{
		{"today in outlet zone", "x", order("x", "2026-11-28"), true},
		{"oldest day of the window", "x", order("x", "2026-11-22"), true},
		{"one day too old", "x", order("x", "2026-11-21"), false},
		{"future date", "x", order("x", "2026-11-29"), false},
		{"other outlet", "y", order("x", "2026-11-28"), false},
		{"no active outlet", "", order("x", "2026-11-28"), false},
		{"missing business date", "x", order("x", ""), false},
	}
	for _, c := range cases {
		if got := storedPhoneAllowed(c.active, c.o, now); got != c.want {
			t.Errorf("%s: got %v want %v", c.name, got, c.want)
		}
	}
}

func TestRoundingRow(t *testing.T) {
	d := read.ReceiptPageData{Subtotal: 100500, Discount: 0, Total: 100000}
	row, ok := roundingRow(d)
	if !ok || row.Label != "Pembulatan" || row.Amount != "-Rp 500" {
		t.Fatalf("rounded down: %+v ok=%v", row, ok)
	}
	d = read.ReceiptPageData{Subtotal: 99800, Total: 100000}
	if row, ok = roundingRow(d); !ok || row.Amount == "" || row.Amount[0] == '-' {
		t.Fatalf("rounded up should be positive: %+v", row)
	}
	// Points, surcharge and tax are accounted for, so no residual remains.
	d = read.ReceiptPageData{Subtotal: 100000, Discount: 10000, Surcharge: 2000, Tax: 5000, PointsRedeemed: 7000, Total: 90000}
	if _, ok = roundingRow(d); ok {
		t.Fatal("explained order must not get a rounding row")
	}
	if _, ok = roundingRow(read.ReceiptPageData{Subtotal: 100000, Total: 99999.6}); ok {
		t.Fatal("residual below 1 must not show")
	}
}
