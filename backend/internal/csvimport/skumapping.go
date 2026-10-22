package csvimport

import (
	"fmt"
	"strings"
)

// KindSkuMapping is the one-time ERP SKU mapping import (plan 4.2): it links each
// variant to its ERP finished good (sku = fg_code, erp_slug = fg_slug) and optionally
// sets the parent product's erp_group_key. The kind string matches migration 0066's
// import_runs.kind check.
const KindSkuMapping = "sku_mapping"

// SkuMappingSpec is the layout of the sku-mapping export. variant_id, fg_code and fg_slug
// drive the import; the other columns are the export's context columns and are read but
// ignored (declared so they do not produce an "unknown column" warning per file).
var SkuMappingSpec = Spec{
	Columns: []ColumnSpec{
		{Key: "variant_id", Required: true},
		{Key: "product"},
		{Key: "size"},
		{Key: "sku"},
		{Key: "has_stock"},
		{Key: "barcode"},
		{Key: "fg_code", Required: true},
		{Key: "fg_slug", Required: true},
		{Key: "erp_group_key"},
	},
}

// SkuMappingVariant is one current variant. ErpSlug is "" while unlinked.
type SkuMappingVariant struct {
	ID, ProductID, SKU, ErpSlug string
}

// SkuMappingCatalog is the snapshot the planner checks the file against. GroupKeys maps a
// product id to its current erp_group_key ("" = none); GroupKeyOwners is the inverse
// for non-empty keys.
type SkuMappingCatalog struct {
	Variants       []SkuMappingVariant
	GroupKeys      map[string]string
	GroupKeyOwners map[string]string
}

// PlannedSkuMapping is one variant write.
type PlannedSkuMapping struct {
	VariantID, ProductID, OldSKU, FGCode, FGSlug string
}

// SkuMappingPlan is the outcome of planning a mapping file. GroupKeys (product id ->
// key) holds only keys that differ from the stored value.
type SkuMappingPlan struct {
	Report    Report
	Mappings  []PlannedSkuMapping
	GroupKeys map[string]string
}

type skuMappingRow struct {
	row                       Row
	variantID, code, slug, gk string
}

// skuMappingIndex is the per-file lookup state shared by the row checks.
type skuMappingIndex struct {
	cat         SkuMappingCatalog
	byID        map[string]*SkuMappingVariant
	skuOwners   map[string][]*SkuMappingVariant
	slugOwner   map[string]*SkuMappingVariant
	inFile      map[string]bool // variants this file re-maps (their current sku is moving)
	cntVariant  map[string]int
	cntCode     map[string]int
	cntSlug     map[string]int
	productKeys map[string]map[string]bool // product id -> keys given by its rows
	keyProducts map[string]map[string]bool // key -> products given it by the file
}

func newSkuMappingIndex(cat SkuMappingCatalog, mapped []*skuMappingRow) *skuMappingIndex {
	ix := &skuMappingIndex{cat: cat,
		byID: map[string]*SkuMappingVariant{}, skuOwners: map[string][]*SkuMappingVariant{},
		slugOwner: map[string]*SkuMappingVariant{}, inFile: map[string]bool{},
		cntVariant: map[string]int{}, cntCode: map[string]int{}, cntSlug: map[string]int{},
		productKeys: map[string]map[string]bool{}, keyProducts: map[string]map[string]bool{}}
	for i := range cat.Variants {
		v := &cat.Variants[i]
		ix.byID[strings.ToLower(v.ID)] = v
		ix.skuOwners[v.SKU] = append(ix.skuOwners[v.SKU], v)
		if v.ErpSlug != "" {
			ix.slugOwner[v.ErpSlug] = v
		}
	}
	for _, r := range mapped {
		id := strings.ToLower(r.variantID)
		ix.inFile[id] = true
		ix.cntVariant[id]++
		ix.cntCode[r.code]++
		ix.cntSlug[r.slug]++
		v := ix.byID[id]
		if v == nil || r.gk == "" {
			continue
		}
		if ix.productKeys[v.ProductID] == nil {
			ix.productKeys[v.ProductID] = map[string]bool{}
		}
		ix.productKeys[v.ProductID][r.gk] = true
		if ix.keyProducts[r.gk] == nil {
			ix.keyProducts[r.gk] = map[string]bool{}
		}
		ix.keyProducts[r.gk][v.ProductID] = true
	}
	return ix
}

// PlanSkuMapping validates a mapping file. A row with both fg_code and fg_slug empty is
// skipped (not mapped yet); exactly one empty is an error. The whole file applies or
// none of it (any error refuses the commit).
func PlanSkuMapping(t *Table, cat SkuMappingCatalog) (*SkuMappingPlan, error) {
	b := NewBuilder(KindSkuMapping, t)
	plan := &SkuMappingPlan{GroupKeys: map[string]string{}}
	if t.HasFileError() {
		plan.Report = b.Report()
		return plan, nil
	}
	var rows, mapped []*skuMappingRow
	for _, row := range t.Rows {
		b.Begin(row)
		c := row.Cells
		r := &skuMappingRow{row: row, variantID: strings.TrimSpace(c["variant_id"]),
			code: strings.TrimSpace(c["fg_code"]), slug: strings.TrimSpace(c["fg_slug"]),
			gk: strings.TrimSpace(c["erp_group_key"])}
		rows = append(rows, r)
		if r.code != "" || r.slug != "" {
			mapped = append(mapped, r)
		}
	}
	ix := newSkuMappingIndex(cat, mapped)

	for _, r := range rows {
		row, key := r.row, r.variantID
		if r.code == "" && r.slug == "" {
			if r.gk != "" {
				b.Issue(row, "erp_group_key", SevError, "group_key_needs_fg", "erp_group_key butuh fg_code dan fg_slug", r.gk)
				b.Row(row, ActionError, key, "")
				continue
			}
			b.Row(row, ActionSkip, key, "belum dipetakan (fg_code dan fg_slug kosong)")
			continue
		}
		ix.check(b, r)
		if b.RowHasError(row) {
			b.Row(row, ActionError, key, "")
			continue
		}
		v := ix.byID[strings.ToLower(r.variantID)]
		keyChanged := r.gk != "" && cat.GroupKeys[v.ProductID] != r.gk
		linkChanged := v.SKU != r.code || v.ErpSlug != r.slug
		if !linkChanged && !keyChanged {
			b.Row(row, ActionSkip, key, noChange)
			continue
		}
		if linkChanged {
			plan.Mappings = append(plan.Mappings, PlannedSkuMapping{VariantID: v.ID, ProductID: v.ProductID, OldSKU: v.SKU, FGCode: r.code, FGSlug: r.slug})
		}
		if keyChanged {
			plan.GroupKeys[v.ProductID] = r.gk
		}
		b.Row(row, ActionUpdate, key, "")
	}
	plan.Report = b.Report()
	return plan, nil
}

func (ix *skuMappingIndex) check(b *Builder, r *skuMappingRow) {
	row := r.row
	if r.code == "" {
		b.Issue(row, "fg_code", SevError, "required", "fg_code wajib diisi bila fg_slug diisi", "")
	} else {
		checkMax(b, row, "fg_code", r.code, MaxCode)
	}
	if r.slug == "" {
		b.Issue(row, "fg_slug", SevError, "required", "fg_slug wajib diisi bila fg_code diisi", "")
	} else {
		checkMax(b, row, "fg_slug", r.slug, MaxName)
	}
	if r.gk != "" {
		checkMax(b, row, "erp_group_key", r.gk, MaxName)
	}
	id := strings.ToLower(r.variantID)
	if id == "" {
		b.Issue(row, "variant_id", SevError, "required", "variant_id wajib diisi", "")
		return
	}
	v := ix.byID[id]
	if v == nil {
		b.Issue(row, "variant_id", SevError, "unknown_variant", "variant_id tidak dikenal", r.variantID)
		return
	}
	if ix.cntVariant[id] > 1 {
		b.Issue(row, "variant_id", SevError, "duplicate_in_file", "varian yang sama muncul lebih dari satu kali di file", r.variantID)
	}
	ix.checkCode(b, r, v)
	ix.checkSlug(b, r, v)
	ix.checkGroupKey(b, r, v)
}

func (ix *skuMappingIndex) checkCode(b *Builder, r *skuMappingRow, v *SkuMappingVariant) {
	if r.code == "" {
		return
	}
	if ix.cntCode[r.code] > 1 {
		b.Issue(r.row, "fg_code", SevError, "duplicate_in_file", "fg_code yang sama dipakai lebih dari satu baris", r.code)
	}
	for _, o := range ix.skuOwners[r.code] {
		if o.ID != v.ID && !ix.inFile[strings.ToLower(o.ID)] {
			b.Issue(r.row, "fg_code", SevError, "sku_in_use", "fg_code sudah dipakai sebagai SKU oleh varian lain", r.code)
			return
		}
	}
}

func (ix *skuMappingIndex) checkSlug(b *Builder, r *skuMappingRow, v *SkuMappingVariant) {
	if r.slug == "" {
		return
	}
	if ix.cntSlug[r.slug] > 1 {
		b.Issue(r.row, "fg_slug", SevError, "duplicate_in_file", "fg_slug yang sama dipakai lebih dari satu baris", r.slug)
	}
	if o := ix.slugOwner[r.slug]; o != nil && o.ID != v.ID {
		b.Issue(r.row, "fg_slug", SevError, "slug_linked", "fg_slug sudah terhubung ke varian lain", r.slug)
	}
}

func (ix *skuMappingIndex) checkGroupKey(b *Builder, r *skuMappingRow, v *SkuMappingVariant) {
	if r.gk == "" {
		return
	}
	if n := len(ix.productKeys[v.ProductID]); n > 1 {
		b.Issue(r.row, "erp_group_key", SevError, "group_key_conflict",
			fmt.Sprintf("baris-baris produk yang sama punya erp_group_key berbeda (%d nilai)", n), r.gk)
	}
	if len(ix.keyProducts[r.gk]) > 1 {
		b.Issue(r.row, "erp_group_key", SevError, "group_key_conflict",
			"erp_group_key yang sama dipakai oleh lebih dari satu produk di file", r.gk)
	}
	if owner := ix.cat.GroupKeyOwners[r.gk]; owner != "" && owner != v.ProductID {
		b.Issue(r.row, "erp_group_key", SevError, "group_key_in_use", "erp_group_key sudah dipakai produk lain", r.gk)
	}
}
