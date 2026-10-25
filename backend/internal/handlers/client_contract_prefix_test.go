package handlers

import (
	"strings"
	"testing"

	"github.com/mandalika/pos-backend/internal/service"
	"github.com/mandalika/pos-backend/internal/write"
)

// The POS Permintaan Barang client tells a 409 apart by the start of the server's Indonesian
// text (apps/pos/src/cashier/requisitions/requisitionFlow.ts: KEY_CONFLICT_PREFIX, BUSY_PREFIX).
// The same two literals are asserted in requisitionFlow.test.ts, so renaming either server text
// fails a test on both sides instead of silently turning a retry into a "stale" refetch.
const (
	clientKeyConflictPrefix = "kunci idempotensi"
	clientBusyPrefix        = "sedang diproses permintaan lain"
)

func TestClientContractConflictPrefixes(t *testing.T) {
	if got := service.ErrReceiptKeyConflict.Error(); !strings.HasPrefix(got, clientKeyConflictPrefix) {
		t.Fatalf("ErrReceiptKeyConflict %q must start with %q (client KEY_CONFLICT_PREFIX)", got, clientKeyConflictPrefix)
	}
	if got := write.ErrBusy.Error(); !strings.HasPrefix(got, clientBusyPrefix) {
		t.Fatalf("ErrBusy %q must start with %q (client BUSY_PREFIX)", got, clientBusyPrefix)
	}
}
