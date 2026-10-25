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
// Tombstoned, DISCONTINUE and PENDING are inactive (owner answer 2026-10-22, handoff Q3:
// PENDING is not sellable); ACTIVE/FAVOURITE/NEW_LAUNCHING are active.
func FGActive(fg erpapi.IntegrationFG) bool {
	return fg.DeletedAt == nil && fg.Status != erpapi.DISCONTINUE && fg.Status != erpapi.PENDING
}

// SizeLabel builds the variant size label. A missing size is "Satuan". The FG unit
// is the ERP's stock unit (Pcs, Botol, ...), not the unit of size: for liquids the
// size is in ml (ERP reply 2026-10-24, K2/Q2). So size 110 with unit "Pcs" is
// "110ml", never "110pcs". Only an explicit measurement unit (measureUnits) replaces
// the ml default ("50gr"). Non-integers keep their decimals ("7.5ml"). Derived once,
// when the variant is created, and never rewritten afterwards.
func SizeLabel(size *float64, unit *string) string {
	if size == nil {
		return sizeUnitless
	}
	suffix := "ml"
	if unit != nil {
		if u := strings.ToLower(strings.TrimSpace(*unit)); measureUnits[u] {
			suffix = u
		}
	}
	return strconv.FormatFloat(*size, 'f', -1, 64) + suffix
}

// measureUnits are FG units that say what the size measures; any other unit is a
// stock/count unit and leaves the size in ml.
var measureUnits = map[string]bool{"ml": true, "l": true, "g": true, "gr": true, "kg": true}

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

// GroupKey is the POS-side product grouping rule: the normalised name minus its size
// token. Siblings of one fragrance share it whatever their ERP category (the ERP may
// file sizes of one fragrance under different categories). Category only breaks a
// tie, see CategoryGroupKey.
func GroupKey(name string, size *float64) string {
	return groupKeyPrefix + normKey(ProductNameFromFG(name, size))
}

// CategoryGroupKey is the tie-breaker key: the catalog pull uses it for a new FG only
// when the GroupKey product already holds the FG's size label under another category
// (two products with one name, for example an EDP and a body mist).
func CategoryGroupKey(name string, category *string, size *float64) string {
	cat := ""
	if category != nil {
		cat = *category
	}
	return GroupKey(name, size) + "|" + normKey(cat)
}

func normKey(s string) string { return strings.ToLower(collapseSpaces(s)) }

func collapseSpaces(s string) string { return strings.Join(strings.Fields(s), " ") }
