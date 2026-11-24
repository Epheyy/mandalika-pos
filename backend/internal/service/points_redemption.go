package service

import "math"

// pointsCoverEpsilon keeps float noise (7/0.7 = 10.000000000000002) from costing an extra point.
// The POS redeemPoints (apps/pos/src/cashier/pricing.ts) uses the identical expression.
const pointsCoverEpsilon = 1e-9

// RedeemPoints is the ONE points-consumed rule (A22 rule a), mirrored by POS redeemPoints and pinned
// by testdata/points_redemption_golden.json. p = min(requested, available); value = round(p*rate).
// When the value covers the total the bill becomes Rp0 and the customer spends up to one point extra
// (ceil), capped at p; otherwise the points spent are p. A total <= 0, no points or no rate redeems nothing.
func RedeemPoints(requested, available int, rate, total float64) (points int, amount float64) {
	p := min(requested, available)
	if p <= 0 || rate <= 0 || total <= 0 {
		return 0, 0
	}
	value := math.Round(float64(p) * rate)
	if value >= total {
		return min(p, int(math.Ceil(total/rate-pointsCoverEpsilon))), total
	}
	return p, value
}
