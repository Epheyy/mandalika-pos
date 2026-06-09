package write

import "errors"

// Sentinel errors for manual point adjustments. Handlers map these to HTTP 400
// (client/validation faults); any other error from AdjustPoints is a 500.
var (
	ErrZeroDelta          = errors.New("jumlah penyesuaian tidak boleh nol")
	ErrInsufficientPoints = errors.New("poin tidak cukup untuk pengurangan")
	ErrReasonRequired     = errors.New("alasan penyesuaian wajib")
)

// PointsClawback returns how many points to remove from balance to claw back up to
// `earned`, never driving the balance below zero (the remainder is forgiven).
// Exported because the order service's Refund path uses it.
func PointsClawback(balance, earned int) int {
	if earned <= 0 || balance <= 0 {
		return 0
	}
	if earned >= balance {
		return balance
	}
	return earned
}

// adjustedBalance applies a signed delta to a balance, rejecting a subtraction that
// would drive the balance below zero or a no-op zero delta.
func adjustedBalance(balance, delta int) (int, error) {
	if delta == 0 {
		return 0, ErrZeroDelta
	}
	if delta < 0 && -delta > balance {
		return 0, ErrInsufficientPoints
	}
	return balance + delta, nil
}
