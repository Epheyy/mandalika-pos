package bundles

import "errors"

// MaxBundleMoney bounds every rupiah value the split multiplies (1e9), so
// amount*basis stays under 1e18 and never overflows int64.
const MaxBundleMoney int64 = 1_000_000_000

// ErrSplitInput is returned by Split for an amount or basis outside its limits.
var ErrSplitInput = errors.New("bundles: split amount or basis out of range")

// Split divides amount between the three pieces in proportion to their single prices
// (basis, index order large, atomizer, vial). The atomizer and vial shares are floored;
// the rounding remainder lands on the large bottle, so the shares always sum to amount.
// It fails when amount is negative or any value is outside 1..MaxBundleMoney (amount 0
// is allowed). The TypeScript twin reads the same golden file.
func Split(amount int64, basis [3]int64) ([3]int64, error) {
	if amount < 0 || amount > MaxBundleMoney {
		return [3]int64{}, ErrSplitInput
	}
	for _, b := range basis {
		if b <= 0 || b > MaxBundleMoney {
			return [3]int64{}, ErrSplitInput
		}
	}
	s := basis[0] + basis[1] + basis[2]
	a := amount * basis[1] / s
	v := amount * basis[2] / s
	return [3]int64{amount - a - v, a, v}, nil
}

// MinNet is the smallest bundle net (price minus discount) at which every piece's share
// is at least Rp1: the atomizer and vial shares are floor(net*p/S), which is >= 1 only
// when net >= ceil(S/p); the large share is then >= 1 by construction. Basis values
// must be positive.
func MinNet(basis [3]int64) int64 {
	s := basis[0] + basis[1] + basis[2]
	ceilDiv := func(p int64) int64 { return (s + p - 1) / p }
	a, v := ceilDiv(basis[1]), ceilDiv(basis[2])
	if a > v {
		return a
	}
	return v
}
