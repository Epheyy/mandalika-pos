package service

import "testing"

func TestRefundInputSaleOutlet(t *testing.T) {
	if got := (RefundInput{OutletID: "y"}).saleOutlet(); got != "y" {
		t.Fatalf("empty SaleOutletID must fall back to OutletID, got %q", got)
	}
	if got := (RefundInput{OutletID: "y", SaleOutletID: "x"}).saleOutlet(); got != "x" {
		t.Fatalf("SaleOutletID wins, got %q", got)
	}
}
