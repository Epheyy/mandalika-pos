// Package bundles derives the automatic three-piece bundle catalog (large bottle + 10ml
// atomizer + 2ml vial of the same ERP line) from the product variants and the owner's
// bundle price settings. It is pure: no database, no HTTP. Go is the only place that
// decides what a bundle is; tablets and the Backoffice receive the derived result.
package bundles

import (
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/mandalika/pos-backend/internal/integration/erp/erpmap"
)

// Role is what a variant is inside a bundle.
type Role string

const (
	RoleLarge    Role = "large"
	RoleAtomizer Role = "atomizer"
	RoleVial     Role = "vial"
)

const (
	atomizerSize     = "10ml"
	vialSize         = "2ml"
	atomizerCategory = "ATOMIZER"
)

// DefaultLargeSizes are the large sizes the Backoffice always offers a standard price for.
var DefaultLargeSizes = []string{"100ml", "110ml", "120ml"}

var sizeRe = regexp.MustCompile(`(?i)^\s*(\d+)\s*ml\b`)

// ParseSizeML reads the leading "<n>ml" of a variant label ("120ml EXTRAIT DE PARFUM" ->
// "120ml", " 2 ML" -> "2ml"). ok is false for "Satuan", "" or a zero size.
func ParseSizeML(label string) (string, bool) {
	m := sizeRe.FindStringSubmatch(label)
	if m == nil {
		return "", false
	}
	n, err := strconv.Atoi(m[1])
	if err != nil || n <= 0 {
		return "", false
	}
	return strconv.Itoa(n) + "ml", true
}

func collapseUpper(s string) string {
	return strings.ToUpper(strings.Join(strings.Fields(s), " "))
}

// LineOf is the bundle line of an ERP category: only EXT (Extrait) and PERFUME INTENSE
// (Parfum Intense) are lines. ATOMIZER, DISPLAY, HAMPERS, GLITTER, ... are not.
func LineOf(category string) (string, bool) {
	c := collapseUpper(category)
	if c != "EXT" && c != "PERFUME INTENSE" {
		return "", false
	}
	return erpmap.Line(c)
}

// LineInfo is the display label and short name of a line ("" for no line).
func LineInfo(line string) (label, short string) {
	switch line {
	case "EXTRAIT DE PARFUM":
		return "Extrait", "EXT"
	case "PARFUM INTENSE":
		return "Parfum Intense", "PI"
	}
	return "", ""
}

// Variant is one product variant as the derivation needs it.
type Variant struct {
	ProductID, ProductName string
	Label                  string // product_variants.size, e.g. "120ml EXTRAIT DE PARFUM"
	ErpCategory            string
	// ErpLinked is erp_slug IS NOT NULL. A blank category on a linked variant means "not a
	// piece", never "no ERP data".
	ErpLinked bool
	Price     float64
	Active    bool
}

// Prices holds the bundle price settings: Standard by size, Lines by line then size.
type Prices struct {
	Standard map[string]float64
	Lines    map[string]map[string]float64
}

// PriceFor is the bundle price of (line, size): the line price when set, else the standard
// one. ok is false when the size has no standard price.
func (p Prices) PriceFor(line, size string) (float64, bool) {
	std, ok := p.Standard[size]
	if !ok || std <= 0 {
		return 0, false
	}
	if lp, ok := p.Lines[line][size]; ok && lp > 0 {
		return lp, true
	}
	return std, true
}

// LargeSizes are the sizes with a standard price, smallest first.
func (p Prices) LargeSizes() []string {
	out := make([]string, 0, len(p.Standard))
	for s := range p.Standard {
		out = append(out, s)
	}
	sort.Slice(out, func(i, j int) bool { return sizeNum(out[i]) < sizeNum(out[j]) })
	return out
}

func sizeNum(size string) int {
	n, _ := strconv.Atoi(strings.TrimSuffix(size, "ml"))
	return n
}

// Piece is a variant that can be part of a bundle.
type Piece struct {
	ProductID, VariantSize string
	Role                   Role
	Line, Size             string
}

// Classify decides whether v is a bundle piece. Testers, hampers, other categories, 15ml,
// inactive variants and variants priced at 0 or less never are.
func Classify(v Variant, p Prices) (Piece, bool) {
	size, ok := ParseSizeML(v.Label)
	if !ok || !v.Active || v.Price <= 0 {
		return Piece{}, false
	}
	piece := func(role Role, line string) (Piece, bool) {
		return Piece{ProductID: v.ProductID, VariantSize: v.Label, Role: role, Line: line, Size: size}, true
	}
	std, hasStd := p.Standard[size]
	hasStd = hasStd && std > 0
	if !v.ErpLinked {
		// Test catalog: no ERP data, so the size alone decides and there is no line.
		switch {
		case size == atomizerSize:
			return piece(RoleAtomizer, "")
		case size == vialSize:
			return piece(RoleVial, "")
		case hasStd:
			return piece(RoleLarge, "")
		}
		return Piece{}, false
	}
	if collapseUpper(v.ErpCategory) == atomizerCategory {
		if size == atomizerSize {
			return piece(RoleAtomizer, "")
		}
		return Piece{}, false
	}
	line, ok := LineOf(v.ErpCategory)
	if !ok {
		return Piece{}, false
	}
	switch {
	case size == vialSize:
		return piece(RoleVial, line)
	case hasStd:
		return piece(RoleLarge, line)
	}
	return Piece{}, false
}
