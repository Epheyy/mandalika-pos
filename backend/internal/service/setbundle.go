package service

import (
	"math"
	"slices"

	"github.com/mandalika/pos-backend/internal/bundles"
)

// Bundle sale violations (stored in orders.discount_warning_reason).
const (
	// ViolationBundlePriceChanged: the bundle list price the tablet used differs from today's
	// setting. Online it is a 422; for a synced sale it is a flag only (the tablet price is kept).
	ViolationBundlePriceChanged PromoViolation = "bundle_price_changed"
	// ViolationBundleBasisReplaced: a synced sale's split basis failed the MinNet rule, so the
	// catalog basis was used instead. A warning only, never a 422.
	ViolationBundleBasisReplaced PromoViolation = "bundle_basis_replaced"
	// ViolationBundleZeroPiece: a kept (invalid, synced) bundle has a piece at Rp0, which would
	// reach the ERP as a free line. A flag only.
	ViolationBundleZeroPiece PromoViolation = "bundle_zero_piece"
)

// setBundlePiece is one sale line of a bundle group as the pricing core needs it.
type setBundlePiece struct {
	idx          int // index in the sale's item slice
	role         bundles.Role
	piece        bundles.Piece
	classified   bool  // the variant is a valid bundle piece today
	clientBasis  int64 // BundleBasisPrice from the tablet, 0 when absent
	catalogBasis int64 // the outlet catalog single price
}

// setBundleGroup is the pieces sharing one bundleGroup number.
type setBundleGroup struct {
	group       int
	pieces      []setBundlePiece
	clientPrice float64 // the large piece's BundlePrice; 0 when the tablet sent none
	// mismatch is set when the three pieces disagree on BundlePrice: never a legitimate cart.
	mismatch bool
}

// setBundlePriced is the server's resolution of one bundle group.
type setBundlePriced struct {
	ok          bool // false: the group is invalid (the violations say why)
	line, size  string
	price       int64 // list price actually used, before any Diskon Bundle
	discount    int64 // Diskon Bundle amount (0 when none applies)
	promotionID string
	shares      [3]int64 // net per piece, index order large, atomizer, vial
	discShares  [3]int64 // the discount share per piece
}

// bestBundleDiscount picks the biggest Diskon Bundle for one bundle (a tie goes to the
// lexicographically smaller promotion id). The amount is clamped to price - MinNet(basis) so no
// piece reaches Rp0, and floored at 0. Line "" matches only a promotion with an empty Lines list.
func bestBundleDiscount(price int64, line, size string, basis [3]int64, specs []PromoSpec) (amount int64, promotionID string) {
	limit := price - bundles.MinNet(basis)
	for _, sp := range specs {
		c := sp.BundleDiscount
		if sp.Kind != DiscountBundleDiscount || c == nil {
			continue
		}
		if (len(c.Lines) > 0 && !slices.Contains(c.Lines, line)) || (len(c.Sizes) > 0 && !slices.Contains(c.Sizes, size)) {
			continue
		}
		d := int64(math.Round(sp.Value))
		if c.Kind == DiscountPercentage {
			d = int64(math.Round(float64(price) * sp.Value / 100))
		}
		d = max(min(d, limit), 0)
		if d > amount || (d == amount && d > 0 && sp.ID < promotionID) {
			amount, promotionID = d, sp.ID
		}
	}
	return amount, promotionID
}

var roleIndex = map[bundles.Role]int{bundles.RoleLarge: 0, bundles.RoleAtomizer: 1, bundles.RoleVial: 2}

// priceSetBundle validates one bundle group and splits its price over the pieces. A failure
// returns ok=false and the violations (ViolationBundleInvalid, or BundlePriceChanged for an
// online stale price). Warnings of a usable group (an offline stale price or a replaced basis)
// come back with ok=true. Pure: no database.
func priceSetBundle(g setBundleGroup, prices bundles.Prices, offline bool, discounts []PromoSpec) (setBundlePriced, []PromoViolation) {
	invalid := []PromoViolation{ViolationBundleInvalid}
	if g.mismatch || len(g.pieces) != 3 {
		return setBundlePriced{}, invalid
	}
	var byRole [3]*setBundlePiece
	for i := range g.pieces {
		p := &g.pieces[i]
		ri, known := roleIndex[p.role]
		if !known || byRole[ri] != nil || !p.classified || p.piece.Role != p.role {
			return setBundlePriced{}, invalid
		}
		byRole[ri] = p
	}
	large, vial := byRole[0], byRole[2]
	if large.piece.Line != vial.piece.Line {
		return setBundlePriced{}, invalid
	}
	catalogPrice, ok := prices.PriceFor(large.piece.Line, large.piece.Size)
	if !ok {
		return setBundlePriced{}, invalid
	}
	price := int64(math.Round(catalogPrice))
	var warns []PromoViolation
	if g.clientPrice > 0 {
		if client := int64(math.Round(g.clientPrice)); client != price {
			if !offline {
				return setBundlePriced{}, []PromoViolation{ViolationBundlePriceChanged}
			}
			price = client // a tablet sale keeps the price it captured
			warns = append(warns, ViolationBundlePriceChanged)
		}
	}

	catalog := [3]int64{byRole[0].catalogBasis, byRole[1].catalogBasis, byRole[2].catalogBasis}
	client := [3]int64{byRole[0].clientBasis, byRole[1].clientBasis, byRole[2].clientBasis}
	basisOK := func(b [3]int64) bool {
		for _, v := range b {
			if v <= 0 || v > bundles.MaxBundleMoney {
				return false
			}
		}
		return price >= bundles.MinNet(b)
	}
	clientSent := client[0] > 0 || client[1] > 0 || client[2] > 0
	var basis [3]int64
	switch {
	case clientSent && basisOK(client):
		basis = client
	case clientSent && !offline:
		return setBundlePriced{}, invalid
	default:
		if !basisOK(catalog) {
			return setBundlePriced{}, invalid
		}
		basis = catalog
		if clientSent {
			warns = append(warns, ViolationBundleBasisReplaced)
		}
	}
	discount, promotionID := bestBundleDiscount(price, large.piece.Line, large.piece.Size, basis, discounts)
	shares, err := bundles.Split(price-discount, basis)
	if err != nil {
		return setBundlePriced{}, invalid
	}
	var discShares [3]int64
	if discount > 0 {
		if discShares, err = bundles.Split(discount, basis); err != nil {
			return setBundlePriced{}, invalid
		}
	}
	return setBundlePriced{
		ok: true, line: large.piece.Line, size: large.piece.Size,
		price: price, discount: discount, promotionID: promotionID, shares: shares, discShares: discShares,
	}, warns
}
