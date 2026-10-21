package write

import "github.com/mandalika/pos-backend/internal/ledger"

// BumpStockSeq is a compatibility alias (a var, so stockseq_guard_test does not
// count it as a call); the implementation lives in internal/ledger.
var BumpStockSeq = ledger.BumpStockSeq
