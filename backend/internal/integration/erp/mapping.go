package erp

import (
	"strings"

	"github.com/mandalika/pos-backend/internal/integration/erp/erpapi"
	"github.com/mandalika/pos-backend/internal/integration/erp/erpmap"
)

// ERP finished-good -> POS catalog mapping rules, mapping v3 (sandbox pull report
// 2026-10-26 §6 and owner decisions 2026-10-26). The pure naming rules are in erpmap; this
// file applies them to the generated ERP types. No DB, no I/O.

// sizeUnitless is the label POS already uses for a variant without a size.
const sizeUnitless = erpmap.Unitless

// FGActive reports whether a finished good should be sellable-eligible in the POS.
// Tombstoned, DISCONTINUE and PENDING are inactive (owner answer 2026-10-22, handoff Q3:
// PENDING is not sellable); ACTIVE/FAVOURITE/NEW_LAUNCHING are active.
func FGActive(fg erpapi.IntegrationFG) bool {
	return fg.DeletedAt == nil && fg.Status != erpapi.DISCONTINUE && fg.Status != erpapi.PENDING
}

// SizeLabel builds the size part of a variant label. A missing size is "Satuan". The FG
// unit is the ERP's stock unit (Pcs, Botol, ...), not the unit of size: for liquids the size
// is in ml (ERP reply 2026-10-24, K2/Q2). So size 110 with unit "Pcs" is "110ml".
func SizeLabel(size *float64, unit *string) string { return erpmap.SizeLabel(size, unit) }

// VariantLabel is the label of the variant a new FG creates: "<size>ml <LINE>" for a sellable
// FG ("120ml EXTRAIT DE PARFUM"), "Satuan" for an others item. Derived once, when the
// variant is created, and never rewritten afterwards.
func VariantLabel(fg erpapi.IntegrationFG) string {
	return erpmap.VariantLabel(fg.IsOthers, fg.Size, fg.Unit, fg.Category)
}

// ProductNameFromFG is the product name of a sellable FG: the ERP name without its
// " - <n>ML <line>" suffix ("24HOURS - 100ML EXTRAIT" -> "24HOURS"). Every size of one
// fragrance code carries the same name. Used only when the pull creates the product.
func ProductNameFromFG(name string) string { return erpmap.ProductName(name) }

// GroupKey is the products.erp_group_key a new FG joins:
//   - an others item: "erp:<code>", one product per item (OthersGroupKey);
//   - a sellable FG: "erp:<fragrance code>" ("PP120E-NO1" -> "erp:NO1"), so every size and
//     line of one fragrance is one product whatever the ERP name or category says;
//   - a sellable FG whose code has no fragrance part: "pos:<lower(product name)>".
//
// An existing POS product joins its fragrance by carrying the same key (set by the
// SKU-mapping import).
func GroupKey(fg erpapi.IntegrationFG) string {
	if fg.IsOthers {
		return OthersGroupKey(fg.Code)
	}
	if fc := erpmap.FragranceCode(fg.Code); fc != "" {
		return "erp:" + fc
	}
	return "pos:" + normKey(ProductNameFromFG(fg.Name))
}

// OthersGroupKey is the product key of an ERP "others" item (display, tester, paper, box,
// packaging): one product per item code (owner decision (b), 2026-10-26).
func OthersGroupKey(code string) string { return "erp:" + strings.TrimSpace(code) }

// OthersProductName names the product of an ERP "others" item: the ERP name with the code
// appended, so a display filed under a bare fragrance name ("24HOURS", DP120E-24H) never
// reads like the fragrance product.
func OthersProductName(name, code string) string {
	return collapseSpaces(name) + " (" + strings.TrimSpace(code) + ")"
}

// genderCategory maps the ERP gender to the POS category a NEW fragrance product is filed
// under (owner decision (a), 2026-10-26). Matched to an existing category only, never
// created; the ERP gender is not consistent (UNSTOPPABLE is WOMEN in the ERP, UNISEX in the
// POS), so it is a default the owner overrides, and later pulls never change it.
var genderCategory = map[erpapi.IntegrationFGGender]string{
	erpapi.MEN: "MAN", erpapi.WOMEN: "WOMAN", erpapi.UNISEX: "UNISEX",
}

// GroupGenders is the majority ERP gender of each sellable group in a page (GORGEOUS
// TUBEROSE: 5 WOMEN, 2 UNISEX -> WOMEN). A tie goes to the gender of the lowest FG code.
// Others items have their own products and are not counted.
func GroupGenders(items []erpapi.IntegrationFG) map[string]erpapi.IntegrationFGGender {
	type tally struct {
		n       int
		minCode string
	}
	counts := map[string]map[erpapi.IntegrationFGGender]*tally{}
	for _, fg := range items {
		if fg.IsOthers || !fg.Gender.Valid() {
			continue
		}
		k := GroupKey(fg)
		if counts[k] == nil {
			counts[k] = map[erpapi.IntegrationFGGender]*tally{}
		}
		t := counts[k][fg.Gender]
		if t == nil {
			t = &tally{minCode: fg.Code}
			counts[k][fg.Gender] = t
		}
		t.n++
		t.minCode = min(t.minCode, fg.Code)
	}
	out := make(map[string]erpapi.IntegrationFGGender, len(counts))
	for k, byGender := range counts {
		var best erpapi.IntegrationFGGender
		var bt *tally
		for g, t := range byGender {
			if bt == nil || t.n > bt.n || t.n == bt.n && t.minCode < bt.minCode {
				best, bt = g, t
			}
		}
		out[k] = best
	}
	return out
}

func normKey(s string) string { return strings.ToLower(collapseSpaces(s)) }

func collapseSpaces(s string) string { return strings.Join(strings.Fields(s), " ") }
