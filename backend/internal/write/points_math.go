package write

import "fmt"

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
		return 0, fmt.Errorf("jumlah penyesuaian tidak boleh nol")
	}
	if delta < 0 && -delta > balance {
		return 0, fmt.Errorf("poin tidak cukup untuk pengurangan")
	}
	return balance + delta, nil
}
