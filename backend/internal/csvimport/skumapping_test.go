package csvimport

import "testing"

const skuMapHeader = "variant_id,product,size,sku,has_stock,barcode,fg_code,fg_slug,erp_group_key\n"

func skuMapCatalog() SkuMappingCatalog {
	return SkuMappingCatalog{
		Variants: []SkuMappingVariant{
			{ID: "v1", ProductID: "p1", SKU: "SKU-1"},
			{ID: "v2", ProductID: "p1", SKU: "SKU-2"},
			{ID: "v3", ProductID: "p2", SKU: "SKU-3"},
			{ID: "v4", ProductID: "p2", SKU: "FG-4", ErpSlug: "slug-4"}, // already mapped
			{ID: "v5", ProductID: "p3", SKU: "SKU-3"},                   // legacy duplicate of v3
		},
		GroupKeys:      map[string]string{"p2": "grp-two"},
		GroupKeyOwners: map[string]string{"grp-two": "p2"},
	}
}

func planSkuMap(t *testing.T, csv string) *SkuMappingPlan {
	t.Helper()
	p, err := PlanSkuMapping(Read([]byte(csv), SkuMappingSpec), skuMapCatalog())
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func TestPlanSkuMappingUpdateSkipAndUnmapped(t *testing.T) {
	p := planSkuMap(t, skuMapHeader+
		"v1,A,50ml,SKU-1,false,SKU-1,FG-1,slug-1,grp-one\n"+ // update + group key
		"v2,A,100ml,SKU-2,false,SKU-2,,,\n"+ // not mapped yet -> skip
		"v4,B,50ml,FG-4,true,SKU-4,FG-4,slug-4,\n") // identical -> skip
	if p.Report.HasErrors() {
		t.Fatalf("unexpected errors: %+v", p.Report.Issues)
	}
	s := p.Report.Summary
	if s.Update != 1 || s.Skip != 2 || s.Create != 0 || s.Error != 0 {
		t.Fatalf("summary = %+v", s)
	}
	if len(p.Mappings) != 1 || p.Mappings[0] != (PlannedSkuMapping{VariantID: "v1", ProductID: "p1", OldSKU: "SKU-1", FGCode: "FG-1", FGSlug: "slug-1"}) {
		t.Fatalf("mappings = %+v", p.Mappings)
	}
	if p.GroupKeys["p1"] != "grp-one" || len(p.GroupKeys) != 1 {
		t.Fatalf("group keys = %+v", p.GroupKeys)
	}
}

func TestPlanSkuMappingGroupKeyOnlyChangeIsUpdate(t *testing.T) {
	p := planSkuMap(t, skuMapHeader+"v4,B,50ml,FG-4,true,SKU-4,FG-4,slug-4,grp-two\n"+
		"v3,B,100ml,SKU-3,false,SKU-3,,,\n")
	if p.Report.Summary.Skip != 2 || len(p.Mappings) != 0 || len(p.GroupKeys) != 0 {
		t.Fatalf("same key is no change: %+v %+v", p.Report.Summary, p.GroupKeys)
	}
}

func TestPlanSkuMappingRowErrors(t *testing.T) {
	cases := map[string]struct{ csv, code string }{
		"only code":               {"v1,,,,,,FG-1,,\n", "required"},
		"group key without fg":    {"v1,,,,,,,,k1\n", "group_key_needs_fg"},
		"only slug":               {"v1,,,,,,,slug-1,\n", "required"},
		"unknown variant":         {"zzz,,,,,,FG-1,slug-1,\n", "unknown_variant"},
		"blank variant id":        {",,,,,,FG-1,slug-1,\n", "required"},
		"variant twice":           {"v1,,,,,,FG-1,slug-1,\nv1,,,,,,FG-2,slug-2,\n", "duplicate_in_file"},
		"fg_code twice":           {"v1,,,,,,FG-1,slug-1,\nv2,,,,,,FG-1,slug-2,\n", "duplicate_in_file"},
		"fg_slug twice":           {"v1,,,,,,FG-1,slug-1,\nv2,,,,,,FG-2,slug-1,\n", "duplicate_in_file"},
		"code used by other":      {"v1,,,,,,SKU-2,slug-1,\n", "sku_in_use"},
		"code used by legacy dup": {"v5,,,,,,SKU-3,slug-5,\n", "sku_in_use"},
		"slug linked":             {"v1,,,,,,FG-1,slug-4,\n", "slug_linked"},
		"group key owned":         {"v1,,,,,,FG-1,slug-1,grp-two\n", "group_key_in_use"},
		"group key disagree":      {"v1,,,,,,FG-1,slug-1,k1\nv2,,,,,,FG-2,slug-2,k2\n", "group_key_conflict"},
		"key on 2 products":       {"v1,,,,,,FG-1,slug-1,k1\nv3,,,,,,FG-3,slug-3,k1\n", "group_key_conflict"},
		"code too long":           {"v1,,,,,,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA,slug-1,\n", "too_long"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			p := planSkuMap(t, skuMapHeader+c.csv)
			if !hasIssue(p.Report, c.code, SevError) || !p.Report.HasErrors() {
				t.Fatalf("want %s error, got %+v", c.code, p.Report.Issues)
			}
		})
	}
}

func TestPlanSkuMappingCodeMovingAwayIsNotAConflict(t *testing.T) {
	// v1 takes v2's current SKU while v2 is re-mapped away from it in the same file.
	p := planSkuMap(t, skuMapHeader+"v1,,,,,,SKU-2,slug-1,\nv2,,,,,,FG-2,slug-2,\n")
	if p.Report.HasErrors() {
		t.Fatalf("unexpected: %+v", p.Report.Issues)
	}
}

func TestPlanSkuMappingDuplicateErrorsOnBothRows(t *testing.T) {
	p := planSkuMap(t, skuMapHeader+"v1,,,,,,FG-1,slug-1,\nv2,,,,,,FG-1,slug-2,\n")
	rows := map[int]bool{}
	for _, is := range p.Report.Issues {
		if is.Code == "duplicate_in_file" {
			rows[is.Row] = true
		}
	}
	if !rows[1] || !rows[2] {
		t.Fatalf("both rows must carry the error: %+v", p.Report.Issues)
	}
}

func TestPlanSkuMappingMissingRequiredColumn(t *testing.T) {
	p := planSkuMap(t, "variant_id,fg_code\nv1,FG-1\n")
	if !p.Report.HasErrors() {
		t.Fatal("a file without fg_slug column must be refused")
	}
}

// GuardCell and cleanCell share formulaLead: every guarded prefix round-trips, and an
// unguarded value is returned as is.
func TestGuardCellRoundTripsThroughCleanCell(t *testing.T) {
	for i := 0; i < len(formulaLead); i++ {
		v := string(formulaLead[i]) + "SUM(A1)"
		g := GuardCell(v)
		if g != "'"+v {
			t.Errorf("GuardCell(%q) = %q, want an apostrophe prefix", v, g)
		}
		if got := cleanCell(g); got != v {
			t.Errorf("cleanCell(GuardCell(%q)) = %q, want the original", v, got)
		}
	}
	if got := GuardCell("SKU-1"); got != "SKU-1" {
		t.Errorf("GuardCell(plain) = %q", got)
	}
}
