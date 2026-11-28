package bundles

// Effective returns the prices an outlet of a price group charges, from the Standar prices
// and the group's own prices. A group size replaces Standar's standard price and every
// Standar line price for that size ("Premium, else Standar"); the group's line prices then
// apply on top. Two things are ignored: a group size that Standar does not price, and a
// group line price for a size the group does not price (or that was ignored). An empty
// group gives a copy of Standar. It is pure: both inputs are left untouched and the result
// never holds an empty inner Lines map. The TypeScript twin reads the same golden file.
func Effective(standar, group Prices) Prices {
	out := Prices{
		Standard: make(map[string]float64, len(standar.Standard)),
		Lines:    make(map[string]map[string]float64, len(standar.Lines)),
	}
	for size, price := range standar.Standard {
		out.Standard[size] = price
	}
	for line, sizes := range standar.Lines {
		if len(sizes) == 0 {
			continue
		}
		cp := make(map[string]float64, len(sizes))
		for size, price := range sizes {
			cp[size] = price
		}
		out.Lines[line] = cp
	}

	applied := map[string]bool{}
	for size, price := range group.Standard {
		if price <= 0 || standar.Standard[size] <= 0 {
			continue
		}
		applied[size] = true
		out.Standard[size] = price
		for line, sizes := range out.Lines {
			delete(sizes, size)
			if len(sizes) == 0 {
				delete(out.Lines, line)
			}
		}
	}
	for line, sizes := range group.Lines {
		for size, price := range sizes {
			if price <= 0 || !applied[size] {
				continue
			}
			if out.Lines[line] == nil {
				out.Lines[line] = map[string]float64{}
			}
			out.Lines[line][size] = price
		}
	}
	return out
}
