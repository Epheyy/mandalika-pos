package read

import (
	"testing"

	"github.com/mandalika/pos-backend/internal/api"
)

func TestCorrectedBuckets(t *testing.T) {
	isCash := func(m string) bool { return m == "cash" || m == "tunai" }
	s := api.Shift{CashSales: 100000, QrisSales: 50000, TotalSales: 150000}
	cash, card, transfer, qris, total := correctedBuckets(s, map[string]int64{"cash": -100000, "qris": 100000}, isCash)
	if cash != 0 || card != 0 || transfer != 0 || qris != 150000 || total != 150000 {
		t.Fatalf("got cash=%d card=%d transfer=%d qris=%d total=%d", cash, card, transfer, qris, total)
	}
	// A cash-flagged custom id lands in cash; a custom non-cash id is in the total only.
	cash, _, _, qris, total = correctedBuckets(s, map[string]int64{"tunai": 5000, "voucher": 7000}, isCash)
	if cash != 105000 || qris != 50000 || total != 162000 {
		t.Fatalf("custom ids: cash=%d qris=%d total=%d", cash, qris, total)
	}
	// A method flagged cash is never also counted in card/transfer/qris.
	isQrisCash := func(m string) bool { return m == "qris" }
	cash, _, _, qris, _ = correctedBuckets(s, map[string]int64{"qris": 10}, isQrisCash)
	if cash != 100010 || qris != 50000 {
		t.Fatalf("cash-flagged qris: cash=%d qris=%d", cash, qris)
	}
}
