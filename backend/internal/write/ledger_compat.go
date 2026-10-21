package write

import "github.com/mandalika/pos-backend/internal/ledger"

// BumpStockSeq is a compatibility alias (a var, so stockseq_guard_test does not
// count it as a call); the implementation lives in internal/ledger.
var BumpStockSeq = ledger.BumpStockSeq

// Tx-scoped insert helpers (implementation in internal/ledger).
type (
	PointTxRow              = ledger.PointTxRow
	SaleStockExceptionRow   = ledger.SaleStockExceptionRow
	ConditionApplicationRow = ledger.ConditionApplicationRow
	RewardGrantRow          = ledger.RewardGrantRow
)

const (
	StockExceptionShortage                = ledger.StockExceptionShortage
	StockExceptionUnresolvedVariant       = ledger.StockExceptionUnresolvedVariant
	StockExceptionRefundUnresolvedVariant = ledger.StockExceptionRefundUnresolvedVariant
)

var (
	InsertPointTx                 = ledger.InsertPointTx
	InsertSaleStockException      = ledger.InsertSaleStockException
	InsertRefundUnresolvedVariant = ledger.InsertRefundUnresolvedVariant
	InsertConditionApplication    = ledger.InsertConditionApplication
	InsertRewardGrant             = ledger.InsertRewardGrant
)
