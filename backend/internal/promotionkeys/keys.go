// Package promotionkeys defines case-sensitive pid / pid|size coverage.
// No catalog lookup or normalization: historical key spelling is preserved.
package promotionkeys

import "strings"

func Overlap(a, b string) bool {
	ap, _, av := strings.Cut(a, "|")
	bp, _, bv := strings.Cut(b, "|")
	return ap == bp && (!av || !bv || a == b)
}

func SetsOverlap(a, b []string) bool {
	for _, x := range a {
		for _, y := range b {
			if Overlap(x, y) {
				return true
			}
		}
	}
	return false
}

// Alternatives within a group are a union; different groups must be disjoint.
func GroupsOverlap(groups [][]string) bool {
	for i, group := range groups {
		for _, other := range groups[i+1:] {
			if SetsOverlap(group, other) {
				return true
			}
		}
	}
	return false
}
