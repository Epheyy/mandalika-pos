package erp

import (
	"regexp"
	"strconv"
	"strings"

	"github.com/mandalika/pos-backend/internal/integration/erp/erpapi"
)

// Pure ERP finished-good -> POS catalog mapping rules (step 4 design). No DB, no I/O.

// sizeUnitless is the label POS already uses for a variant without a size.
const sizeUnitless = "Satuan"

// groupKeyPrefix leaves room for an "erp:<product_slug>" key if the ERP adds one (K1).
const groupKeyPrefix = "pos:"

var sizeTokenRe = regexp.MustCompile(`(?i)\b\d+(?:[.,]\d+)?\s*ml\b`)

// FGActive reports whether a finished good should be sellable-eligible in the POS.
// Tombstoned and DISCONTINUE are inactive; PENDING/ACTIVE/FAVOURITE/NEW_LAUNCHING
// are active (PENDING is an open ERP question).
func FGActive(fg erpapi.IntegrationFG) bool {
	return fg.DeletedAt == nil && fg.Status != erpapi.DISCONTINUE
}

// SizeLabel builds the variant size label. A missing size is "Satuan"; an
// integer 50 with unit nil/empty/"ml" is "50ml"; other units are lower-cased
// ("50gr"); non-integers keep their decimals ("7.5ml"). Derived once, when the
// variant is created, and never rewritten afterwards.
func SizeLabel(size *float64, unit *string) string {
	if size == nil {
		return sizeUnitless
	}
	suffix := "ml"
	if unit != nil {
		if u := strings.ToLower(strings.TrimSpace(*unit)); u != "" {
			suffix = u
		}
	}
	return strconv.FormatFloat(*size, 'f', -1, 64) + suffix
}

// ProductNameFromFG strips the "<n> ml" size token from an FG name so sibling
// sizes share one POS product name ("Mandalika Oud 50ml" -> "Mandalika Oud").
// Whitespace is collapsed; an empty result falls back to the original name.
// size is the FG's numeric size; the token is matched by pattern, so it is
// reserved for a future stricter match.
func ProductNameFromFG(name string, size *float64) string {
	_ = size
	out := collapseSpaces(sizeTokenRe.ReplaceAllString(name, " "))
	if out == "" {
		return collapseSpaces(name)
	}
	return out
}

// GroupKey is the POS-side product grouping rule (D19): normalised category plus
// normalised stripped name. Siblings of one product in one category share it.
func GroupKey(name string, category *string, size *float64) string {
	cat := ""
	if category != nil {
		cat = *category
	}
	return groupKeyPrefix + normKey(cat) + "|" + normKey(ProductNameFromFG(name, size))
}

func normKey(s string) string { return strings.ToLower(collapseSpaces(s)) }

func collapseSpaces(s string) string { return strings.Join(strings.Fields(s), " ") }
