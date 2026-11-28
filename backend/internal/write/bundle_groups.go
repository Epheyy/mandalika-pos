package write

import (
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// Copy the Backoffice shows verbatim.
const (
	MsgBundleStale            = "Harga bundle sudah diubah orang lain. Muat ulang."
	MsgBundleRevisionRequired = "Revisi harga bundle wajib dikirim. Muat ulang."
	MsgPriceGroupUnknown      = "Kelompok harga tidak ditemukan. Muat ulang."
	MsgBundleOutletUnknown    = "Outlet tidak ditemukan. Muat ulang."
)

// BundleGroupPricesIn is the full price set of one non-default group.
type BundleGroupPricesIn struct {
	GroupID    string
	Standard   []BundlePriceIn
	LinePrices []BundleLinePriceIn
}

// BundleOutletGroupIn moves one outlet into a group (the default group stores NULL).
type BundleOutletGroupIn struct {
	OutletID, GroupID string
}

// BundleConflictError is a refused save the client can fix by reloading (409).
type BundleConflictError struct{ Msg string }

func (e *BundleConflictError) Error() string { return e.Msg }

// IsBundleConflict reports whether err is a BundleConflictError.
func IsBundleConflict(err error) bool {
	var e *BundleConflictError
	return errors.As(err, &e)
}

// bundleGroupState is one group as it will be after the save.
type bundleGroupState struct {
	ID, Name  string
	IsDefault bool
	Listed    bool // the body carries this group's prices
	Standard  map[string]float64
	Lines     map[string]map[string]float64
}

// bundleSizeMl orders sizes like 100ml numerically; anything else sorts last.
func bundleSizeMl(s string) int {
	n, err := strconv.Atoi(strings.TrimSuffix(s, "ml"))
	if err != nil {
		return int(^uint(0) >> 1)
	}
	return n
}

// validateBundleGroups checks the cross-group rule on the merged post-save state: a group may
// only price a size the default group prices. Groups come in sort order, default first.
func validateBundleGroups(groups []bundleGroupState) error {
	var def *bundleGroupState
	for i := range groups {
		if groups[i].IsDefault {
			def = &groups[i]
			break
		}
	}
	if def == nil {
		return nil
	}
	for _, g := range groups {
		if g.IsDefault {
			continue
		}
		sizes := make([]string, 0, len(g.Standard))
		for s := range g.Standard {
			sizes = append(sizes, s)
		}
		sort.Slice(sizes, func(i, j int) bool {
			a, b := bundleSizeMl(sizes[i]), bundleSizeMl(sizes[j])
			if a != b {
				return a < b
			}
			return sizes[i] < sizes[j]
		})
		for _, s := range sizes {
			if _, ok := def.Standard[s]; ok {
				continue
			}
			if g.Listed {
				return fmt.Errorf("Harga %s %s butuh harga %s %s", g.Name, s, def.Name, s)
			}
			return fmt.Errorf("Ukuran %s masih punya harga di kelompok %s. Hapus harga itu dulu.", s, g.Name)
		}
	}
	return nil
}

// bundlePriceRow is one stored bundle_prices row.
type bundlePriceRow struct {
	GroupID, Line, Size string
	Price               float64
}

// bundlePriceRowsChanged reports whether the two row sets differ (order-insensitive).
func bundlePriceRowsChanged(before, after []bundlePriceRow) bool {
	if len(before) != len(after) {
		return true
	}
	type key struct{ g, l, s string }
	seen := make(map[key]float64, len(before))
	for _, r := range before {
		seen[key{r.GroupID, r.Line, r.Size}] = r.Price
	}
	for _, r := range after {
		p, ok := seen[key{r.GroupID, r.Line, r.Size}]
		if !ok || p != r.Price {
			return true
		}
	}
	return false
}
