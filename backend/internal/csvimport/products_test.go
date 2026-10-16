package csvimport

import (
	"strings"
	"testing"
)

const productHeader = "Nama,Brand,Kategori,Deskripsi,Ukuran,Harga,SKU,Barcode,Jual,Aktif,Unggulan\n"

func baseCatalog() Catalog {
	return Catalog{
		Products: []CatalogProduct{
			{ID: "p1", Name: "Melati", Brand: "Mandalika", CategoryID: "c1", Description: "wangi", Sellable: true, Active: true},
			{ID: "p2", Name: "Mawar", Brand: "Flamboyan", Sellable: true, Active: true},
		},
		Variants: []CatalogVariant{
			{ID: "v1", ProductID: "p1", Size: "50 ml", SKU: "MEL-50", Barcode: "MEL-50", Price: 100000},
			{ID: "v2", ProductID: "p1", Size: "100 ml", SKU: "MEL-100", Barcode: "8990001", Price: 180000},
			{ID: "v3", ProductID: "p2", Size: "50 ml", SKU: "MAW-50", Barcode: "MAW-50", Price: 90000},
		},
		Categories: []CatalogCategory{{ID: "c1", Name: "Floral"}},
	}
}

func planProducts(t *testing.T, csv string) *ProductsPlan {
	t.Helper()
	tb := Read([]byte(csv), ProductSpec)
	p, err := PlanProducts(tb, baseCatalog())
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func hasIssue(r Report, code, sev string) bool {
	for _, i := range r.Issues {
		if i.Code == code && i.Severity == sev {
			return true
		}
	}
	return false
}

func TestPlanProductsOneOfTwoVariantsIsMergeOnly(t *testing.T) {
	// The file lists only variant MEL-50 of Melati. The other variant must NOT appear in
	// the plan at all (the old import deleted it together with its stock).
	p := planProducts(t, productHeader+"Melati,Mandalika,,,50 ml,100.000,MEL-50,,,,\n")
	if p.Report.HasErrors() {
		t.Fatalf("%+v", p.Report.Issues)
	}
	if p.Report.Summary.Skip != 1 || p.Report.Summary.Create+p.Report.Summary.Update != 0 {
		t.Fatalf("unchanged row must be a skip: %+v", p.Report.Summary)
	}
	if len(p.Products) != 0 {
		t.Errorf("nothing to write, got %+v", p.Products)
	}
}

func TestPlanProductsPriceParsingAndUpdate(t *testing.T) {
	p := planProducts(t, productHeader+"Melati,Mandalika,,,50 ml,\"125.000\",MEL-50,,,,\n")
	if p.Report.HasErrors() || p.Report.Summary.Update != 1 {
		t.Fatalf("%+v %+v", p.Report.Summary, p.Report.Issues)
	}
	v := p.Products[0].Variants[0]
	if v.Price != 125000 || !v.Update || v.Create || v.RenameFrom != "" || v.ExistingID != "v1" {
		t.Errorf("variant %+v (150.000 style price must be thousands, not decimals)", v)
	}
	if p.Products[0].Sellable != nil || p.Products[0].Active != nil || p.Products[0].Featured != nil || p.Products[0].Description != nil {
		t.Errorf("blank optional cells must keep existing values on update: %+v", p.Products[0])
	}
}

func TestPlanProductsCreateAppliesDefaultsAndNewCategory(t *testing.T) {
	p := planProducts(t, productHeader+
		"Anggrek,Mandalika,Baru,,30 ml,75000,ANG-30,,,,\n"+
		"Anggrek,Mandalika,baru,Deskripsi A,60 ml,120000,ANG-60,SCAN-60,Tidak,Ya,Ya\n")
	if p.Report.HasErrors() {
		t.Fatalf("%+v", p.Report.Issues)
	}
	if p.Report.Summary.Create != 2 || p.Report.Summary.NewCategories != 1 || len(p.NewCategories) != 1 || p.NewCategories[0] != "Baru" {
		t.Fatalf("%+v %v", p.Report.Summary, p.NewCategories)
	}
	pp := p.Products[0]
	if pp.ExistingID != "" || pp.CategoryName != "Baru" || *pp.Description != "Deskripsi A" {
		t.Errorf("%+v", pp)
	}
	if *pp.Sellable != false || *pp.Active != true || *pp.Featured != true {
		t.Errorf("first non-blank cell wins: sellable=%v active=%v featured=%v", *pp.Sellable, *pp.Active, *pp.Featured)
	}
	if pp.Variants[0].Barcode != "ANG-30" || pp.Variants[1].Barcode != "SCAN-60" || !pp.Variants[0].Create {
		t.Errorf("barcode defaults to the SKU: %+v", pp.Variants)
	}
}

func TestPlanProductsNewProductDefaultsWhenBlank(t *testing.T) {
	p := planProducts(t, productHeader+"Anggrek,Mandalika,,,30 ml,75000,ANG-30,,,,\n")
	pp := p.Products[0]
	if !*pp.Sellable || !*pp.Active || *pp.Featured || pp.Description != nil {
		t.Errorf("Jual/Aktif default Ya, Unggulan Tidak: %+v", pp)
	}
}

func TestPlanProductsRowErrors(t *testing.T) {
	cases := []struct {
		name, row, code string
	}{
		{"missing brand", "Melati,,,,50 ml,1000,MEL-50,,,,\n", "required"},
		{"missing sku", "Melati,Mandalika,,,50 ml,1000,,,,,\n", "required"},
		{"missing price", "Melati,Mandalika,,,50 ml,,MEL-50,,,,\n", "required"},
		{"bad price", "Melati,Mandalika,,,50 ml,1.5,MEL-50,,,,\n", "invalid_number"},
		{"negative price", "Melati,Mandalika,,,50 ml,-100,MEL-50,,,,\n", "invalid_number"},
		{"bad bool", "Melati,Mandalika,,,50 ml,1000,MEL-50,,Mungkin,,\n", "invalid_bool"},
		{"sku on another product", "Melati,Mandalika,,,50 ml,1000,MAW-50,,,,\n", "sku_on_other_product"},
		{"new product reuses a sku", "Baru,Mandalika,,,50 ml,1000,MEL-50,,,,\n", "sku_on_other_product"},
		{"barcode owned by another variant", "Melati,Mandalika,,,50 ml,1000,MEL-50,8990001,,,\n", "barcode_in_use"},
		{"new variant sku equals a taken barcode", "Melati,Mandalika,,,25 ml,1000,8990001,,,,\n", "barcode_in_use"},
		{"new variant reuses a size", "Melati,Mandalika,,,50 ml,1000,MEL-NEW,,,,\n", "size_exists"},
		{"rename onto another variant size", "Melati,Mandalika,,,100 ml,100000,MEL-50,,,,\n", "size_collision"},
		{"name too long", strings.Repeat("N", MaxName+1) + ",Mandalika,,,50 ml,1000,X-1,,,,\n", "too_long"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			p := planProducts(t, productHeader+c.row)
			if !hasIssue(p.Report, c.code, SevError) {
				t.Fatalf("want error %s, got %+v", c.code, p.Report.Issues)
			}
			if p.Report.Summary.Error != 1 || !p.Report.HasErrors() {
				t.Errorf("row must be an error: %+v", p.Report.Summary)
			}
		})
	}
}

func TestPlanProductsSizeSwapIsRejected(t *testing.T) {
	// Melati 50 ml <-> 100 ml swapped: each rename lands on the other's size, which would
	// collide on the (outlet, product, size) stock key. Both rows must be errors.
	p := planProducts(t, productHeader+
		"Melati,Mandalika,,,100 ml,100000,MEL-50,,,,\n"+
		"Melati,Mandalika,,,50 ml,180000,MEL-100,,,,\n")
	if p.Report.Summary.Error != 2 || !hasIssue(p.Report, "size_collision", SevError) {
		t.Fatalf("%+v %+v", p.Report.Summary, p.Report.Issues)
	}
}

func TestPlanProductsSizeRenameMovesStockWithWarning(t *testing.T) {
	p := planProducts(t, productHeader+"Melati,Mandalika,,,75 ml,100000,MEL-50,,,,\n")
	if p.Report.HasErrors() || !hasIssue(p.Report, "size_rename", SevWarning) {
		t.Fatalf("%+v", p.Report.Issues)
	}
	v := p.Products[0].Variants[0]
	if v.RenameFrom != "50 ml" || v.Size != "75 ml" || !v.Update {
		t.Errorf("%+v", v)
	}
}

func TestPlanProductsInFileDuplicates(t *testing.T) {
	p := planProducts(t, productHeader+
		"Anggrek,Mandalika,,,30 ml,1000,A-1,,,,\n"+
		"Anggrek,Mandalika,,,60 ml,1000,A-1,,,,\n"+ // dup SKU
		"Anggrek,Mandalika,,,30 ml,1000,A-2,,,,\n"+ // dup size
		"Anggrek,Mandalika,,,90 ml,1000,A-3,A-1,,,\n"+ // dup barcode (A-1 is row 1's SKU-barcode)
		"Lain,Mandalika,,,30 ml,1000,A-1,,,,\n") // sku on another product in the file
	for _, code := range []string{"duplicate_sku", "duplicate_size", "duplicate_barcode", "sku_on_other_product"} {
		if !hasIssue(p.Report, code, SevError) {
			t.Errorf("missing %s: %+v", code, p.Report.Issues)
		}
	}
}

func TestPlanProductsConflictingProductCellsWarn(t *testing.T) {
	p := planProducts(t, productHeader+
		"Anggrek,Mandalika,Floral,Satu,30 ml,1000,A-1,,Ya,,\n"+
		"Anggrek,Mandalika,Citrus,Dua,60 ml,1000,A-2,,Tidak,,\n")
	if p.Report.HasErrors() {
		t.Fatal(p.Report.Issues)
	}
	n := 0
	for _, i := range p.Report.Issues {
		if i.Code == "product_field_conflict" {
			n++
		}
	}
	if n != 3 {
		t.Errorf("category, description and Jual conflict = 3 warnings, got %d", n)
	}
	if p.Products[0].CategoryName != "Floral" || *p.Products[0].Description != "Satu" {
		t.Errorf("first row wins: %+v", p.Products[0])
	}
}

func TestPlanProductsProductLevelChangeCountsOnFirstRow(t *testing.T) {
	p := planProducts(t, productHeader+
		"Melati,Mandalika,Floral,Deskripsi baru,50 ml,100000,MEL-50,,,,\n"+
		"Melati,Mandalika,,,100 ml,180000,MEL-100,,,,\n")
	if p.Report.HasErrors() {
		t.Fatal(p.Report.Issues)
	}
	if p.Report.Summary.Update != 1 || p.Report.Summary.Skip != 1 {
		t.Errorf("%+v", p.Report.Summary)
	}
	if len(p.Products) != 1 || *p.Products[0].Description != "Deskripsi baru" || len(p.Products[0].Variants) != 0 {
		t.Errorf("%+v", p.Products)
	}
}

func TestPlanProductsExistingCategoryIsCaseInsensitive(t *testing.T) {
	p := planProducts(t, productHeader+"Melati,Mandalika,floral,,50 ml,100000,MEL-50,,,,\n")
	if p.Report.Summary.NewCategories != 0 || p.Report.Summary.Skip != 1 {
		t.Errorf("%+v", p.Report.Summary)
	}
}

func TestPlanProductsMatchesNameAndBrandCaseInsensitively(t *testing.T) {
	p := planProducts(t, productHeader+"melati,MANDALIKA,,,50 ml,100000,MEL-50,,,,\n")
	if p.Report.Summary.Skip != 1 || p.Report.Summary.Create != 0 {
		t.Errorf("%+v", p.Report.Summary)
	}
}

func TestPlanProductsAmbiguousExistingProduct(t *testing.T) {
	cat := baseCatalog()
	cat.Products = append(cat.Products, CatalogProduct{ID: "p9", Name: "melati", Brand: "mandalika"})
	tb := Read([]byte(productHeader+"Melati,Mandalika,,,50 ml,100000,MEL-50,,,,\n"), ProductSpec)
	p, _ := PlanProducts(tb, cat)
	if !hasIssue(p.Report, "ambiguous_product", SevError) {
		t.Fatalf("%+v", p.Report.Issues)
	}
}

func TestPlanProductsHasNoStockColumnAndZeroPriceWarns(t *testing.T) {
	for _, c := range ProductSpec.Columns {
		if strings.EqualFold(c.Key, "Stok") || strings.EqualFold(c.Key, "Stock") {
			t.Fatal("product import must not have a stock column")
		}
	}
	p := planProducts(t, productHeader+"Anggrek,Mandalika,,,30 ml,0,A-1,,,,\n")
	if p.Report.HasErrors() || !hasIssue(p.Report, "zero_price", SevWarning) {
		t.Fatalf("%+v", p.Report.Issues)
	}
}

func TestPlanProductsRoundTripsGuardedExport(t *testing.T) {
	// A44-era export guards a description that starts with "-" as `'- ...`; importing it
	// back must store the text without the apostrophe.
	p := planProducts(t, productHeader+"Anggrek,Mandalika,,'- bahan alami,30 ml,75000,A-1,,,,\n")
	if p.Report.HasErrors() || *p.Products[0].Description != "- bahan alami" {
		t.Fatalf("%+v %+v", p.Report.Issues, p.Products)
	}
}
