package service

import (
	"fmt"
	"math"

	"github.com/mandalika/pos-backend/internal/apperr"
)

// A09 tender rules. Reasons are stored in orders.tender_warning_reason.
const (
	TenderCashShort       = "cash_short"
	TenderNoncashMismatch = "noncash_amount_mismatch"
	tenderToleranceCents  = 100 // Rp1: a difference of up to one rupiah is not a shortfall/mismatch
)

// ErrTenderRejected is returned for an ONLINE (direct POST /orders) cash shortfall
// so the caller maps it to HTTP 422. Batch/offline sales never produce it.
var ErrTenderRejected = apperr.New(apperr.Rejected, "Uang tunai yang diterima kurang dari total pembayaran")

// errTenderMultiCash is the online reject of a second cash line (D-52). It keeps its own
// text (it is not a cash shortfall) but still matches ErrTenderRejected, so the handler maps
// it to the same 422.
var errTenderMultiCash error = tenderRejection{apperr.New(apperr.Rejected,
	"Hanya boleh satu pembayaran tunai per transaksi, gabungkan menjadi satu baris tunai")}

type tenderRejection struct{ error }

func (e tenderRejection) ErrorCode() apperr.Code { return apperr.Rejected }

func (tenderRejection) Is(target error) bool { return target == error(ErrTenderRejected) }

func tenderRejectedError(paid, due float64) error {
	return fmt.Errorf("%w: diterima %.2f, total %.2f", ErrTenderRejected, paid, due)
}

// evaluateTender applies the tender rules to the captured amount and the server
// total. It returns the amount to store (always the captured amount), the change
// owed (cash only) and a warning reason ("" when the tender is acceptable).
// Comparison is in whole cents with a Rp1 tolerance. Whether a method is cash is
// decided by the caller (IsCashMethod); every other method is non-cash.
func evaluateTender(isCash bool, captured, due float64) (amountPaid, change float64, reason string) {
	capC, dueC := int64(math.Round(captured*100)), int64(math.Round(due*100))
	if isCash {
		switch {
		case capC >= dueC:
			change = float64(capC-dueC) / 100
		case capC < dueC-tenderToleranceCents:
			reason = TenderCashShort
		}
		return captured, change, reason
	}
	diff := capC - dueC
	if diff < 0 {
		diff = -diff
	}
	if diff > tenderToleranceCents {
		reason = TenderNoncashMismatch
	}
	return captured, 0, reason
}
