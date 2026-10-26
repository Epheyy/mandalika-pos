// Package erpmap holds the pure ERP finished-good -> POS catalog naming rules of mapping v3
// (sandbox pull report 2026-10-26 §6). Stdlib only, so the catalog pull (integration/erp)
// and the SKU-mapping import planner (csvimport) apply the same rules.
package erpmap

import (
	"regexp"
	"strconv"
	"strings"
)

// Unitless is the label POS uses for a variant without a size, and for every ERP "others"
// item (display, tester, paper, box, packaging).
const Unitless = "Satuan"

// fragranceCodeRe: an FG code is "<line+size prefix>-<fragrance>" (PP120E-24H, 15GM-NO1,
// A10M-HOL-EX, PP120E-ONL-R). Packaging and hampers (KEM-CAN, HAME-THE) have no digit in the
// prefix and so no fragrance part.
var fragranceCodeRe = regexp.MustCompile(`^(?:[A-Z]+[0-9]+[A-Z]*|[0-9]+[A-Z]+)-(.+)$`)

// FragranceCode is the fragrance part of an FG code ("PP120E-24H" -> "24H"), "" when the code
// does not have that shape. Measured on the 191 sellable production FGs: 31 groups, each with
// one product name and no duplicate label.
func FragranceCode(code string) string {
	m := fragranceCodeRe.FindStringSubmatch(strings.ToUpper(strings.TrimSpace(code)))
	if m == nil {
		return ""
	}
	return m[1]
}

// lines maps the exact ERP category strings of sellable FGs to the POS line label.
var lines = map[string]string{
	"EXT":             "EXTRAIT DE PARFUM",
	"PERFUME INTENSE": "PARFUM INTENSE",
	"ATOMIZER":        "ATOMIZER",
	"GLASS WOMAN":     "GLASS WOMAN",
	"GLASS MAN":       "GLASS MAN",
	"LEATHER":         "LEATHER",
	"GLITTER":         "GLITTER",
}

// Line is the POS line label of an ERP category. An unknown category passes through
// upper-cased with known=false (the caller reports it); a blank one is "" with known=true.
func Line(category string) (line string, known bool) {
	c := strings.ToUpper(collapse(category))
	if c == "" {
		return "", true
	}
	if l, ok := lines[c]; ok {
		return l, true
	}
	return c, false
}

// measureUnits are FG units that say what the size measures; any other unit (Pcs, Botol)
// is a stock unit and leaves the size in ml (ERP reply 2026-10-24, K2/Q2).
var measureUnits = map[string]bool{"ml": true, "l": true, "g": true, "gr": true, "kg": true}

// SizeLabel is the size part of a label: "110ml", "7.5ml", "50gr"; Unitless without a size.
func SizeLabel(size *float64, unit *string) string {
	if size == nil {
		return Unitless
	}
	suffix := "ml"
	if unit != nil {
		if u := strings.ToLower(strings.TrimSpace(*unit)); measureUnits[u] {
			suffix = u
		}
	}
	return strconv.FormatFloat(*size, 'f', -1, 64) + suffix
}

// VariantLabel is the POS variant label "<size>ml <LINE>" ("120ml EXTRAIT DE PARFUM"). An
// others item is always Unitless. A sellable FG without a category is "<size>ml", without a
// size "<LINE>", without both Unitless. Written once, when the variant is created.
func VariantLabel(isOthers bool, size *float64, unit, category *string) string {
	if isOthers {
		return Unitless
	}
	line := ""
	if category != nil {
		line, _ = Line(*category)
	}
	switch {
	case line == "":
		return SizeLabel(size, unit)
	case size == nil:
		return line
	}
	return SizeLabel(size, unit) + " " + line
}

// nameSuffixRe is the " - <n>ML <line>" suffix of ERP names ("24HOURS - 100ML EXTRAIT",
// "NO1 - 110ML M PARFUM INTENSE", "ONLY THE BRAVE - 120ML EXTRAIT REWORK").
var nameSuffixRe = regexp.MustCompile(`(?i)\s+-\s+\d+(?:[.,]\d+)?\s*ML\b.*$`)

// sizeTokenRe is a bare "<n> ml" token inside a name ("Santal Noir 50ml").
var sizeTokenRe = regexp.MustCompile(`(?i)\b\d+(?:[.,]\d+)?\s*ml\b`)

// ProductName is the product name of a sellable FG: the ERP name without its
// " - <n>ML <line>" suffix and without a bare size token, spaces collapsed. An empty result
// falls back to the collapsed name.
func ProductName(name string) string {
	out := collapse(sizeTokenRe.ReplaceAllString(nameSuffixRe.ReplaceAllString(name, ""), " "))
	if out == "" {
		return collapse(name)
	}
	return out
}

func collapse(s string) string { return strings.Join(strings.Fields(s), " ") }
