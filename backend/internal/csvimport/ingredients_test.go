package csvimport

import (
	"strings"
	"testing"
)

const ingredientHeader = "Nama,SKU,Satuan,Kategori,Biaya Default,Catatan,Status\n"

func ingCatalog() IngredientCatalog {
	cost := 15000.0
	return IngredientCatalog{
		Ingredients: []CatalogIngredient{
			{ID: "i1", Name: "Rose Oil", SKU: "RO-001", Unit: "g", CategoryID: "k1", Cost: &cost, Notes: "x", Active: true},
			{ID: "i2", Name: "Alkohol", Unit: "ml", Active: true},
			{ID: "i3", Name: "Dup", Unit: "ml", Active: true},
			{ID: "i4", Name: "dup", Unit: "ml", Active: true},
		},
		Categories: []CatalogCategory{{ID: "k1", Name: "Fragrance Oil"}},
	}
}

func planIngredients(t *testing.T, csv string) *IngredientsPlan {
	t.Helper()
	p, err := PlanIngredients(Read([]byte(csv), IngredientSpec), ingCatalog())
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func TestPlanIngredientsCreateUpdateSkip(t *testing.T) {
	p := planIngredients(t, ingredientHeader+
		"Rose Oil,RO-001,g,Fragrance Oil,15.000,x,Aktif\n"+ // identical -> skip
		"Rose Oil,RO-001,g,fragrance oil,\"12,5\",,\n"+ // update cost... but dup of row1
		"Jasmine,JA-001,g,Baru,1.234,Catatan,Nonaktif\n"+ // create, new category, 1.234 = 1234
		"alkohol,,ml,,,,\n") // matched by name, unchanged
	if !hasIssue(p.Report, "duplicate_in_file", SevError) {
		t.Fatalf("second Rose Oil row is a duplicate: %+v", p.Report.Issues)
	}
	p = planIngredients(t, ingredientHeader+
		"Rose Oil,RO-001,g,Fragrance Oil,15.000,x,Aktif\n"+
		"Jasmine,JA-001,g,Baru,1.234,Catatan,Nonaktif\n"+
		"alkohol,,ml,,,,\n"+
		"Lavender,,ml,,,,\n")
	r := p.Report
	if r.HasErrors() {
		t.Fatal(r.Issues)
	}
	if r.Summary.Skip != 2 || r.Summary.Create != 2 || r.Summary.NewCategories != 1 {
		t.Fatalf("%+v", r.Summary)
	}
	var jas PlannedIngredient
	for _, i := range p.Ingredients {
		if i.Name == "Jasmine" {
			jas = i
		}
	}
	if *jas.Cost != 1234 || *jas.Active != false || jas.CategoryName != "Baru" {
		t.Errorf("%+v cost=%v", jas, *jas.Cost)
	}
}

func TestPlanIngredientsUpdateKeepsBlankCells(t *testing.T) {
	p := planIngredients(t, ingredientHeader+"Rose Oil,RO-001,kg,,,,\n")
	if p.Report.HasErrors() || p.Report.Summary.Update != 1 {
		t.Fatalf("%+v", p.Report)
	}
	pi := p.Ingredients[0]
	if pi.ExistingID != "i1" || pi.Unit != "kg" || pi.Cost != nil || pi.Notes != nil || pi.Active != nil || pi.CategoryName != "" {
		t.Errorf("%+v", pi)
	}
}

func TestPlanIngredientsNewCategoryOnUncategorisedIngredientIsAChange(t *testing.T) {
	p := planIngredients(t, ingredientHeader+"Alkohol,,ml,Pelarut,,,\n")
	if p.Report.HasErrors() || p.Report.Summary.Update != 1 || p.Report.Summary.NewCategories != 1 {
		t.Fatalf("%+v %+v", p.Report.Summary, p.Report.Issues)
	}
	if p.Ingredients[0].CategoryName != "Pelarut" || p.Ingredients[0].ExistingID != "i2" {
		t.Errorf("%+v", p.Ingredients[0])
	}
}

func TestPlanIngredientsErrors(t *testing.T) {
	cases := map[string]string{
		"ambiguous name":    "Dup,,ml,,,,\n",
		"new without unit":  "Baru,B-1,,,,,\n",
		"bad cost":          "Baru,B-1,g,,abc,,\n",
		"bad status":        "Baru,B-1,g,,,,Mungkin\n",
		"missing name":      ",B-1,g,,,,\n",
		"fraction too long": "Baru,B-1,g,,12.5555,,\n",
		"mixed separators":  "Baru,B-1,g,,\"1.234,5\",,\n",
		"negative cost":     "Baru,B-1,g,,-5,,\n",
	}
	for name, row := range cases {
		t.Run(name, func(t *testing.T) {
			p := planIngredients(t, ingredientHeader+row)
			if !p.Report.HasErrors() || p.Report.Summary.Error != 1 {
				t.Fatalf("%+v %+v", p.Report.Summary, p.Report.Issues)
			}
		})
	}
}

func TestPlanIngredientsNameExistsWithOtherSKUWarns(t *testing.T) {
	p := planIngredients(t, ingredientHeader+"Rose Oil,RO-002,g,,,,\n")
	if p.Report.HasErrors() || p.Report.Summary.Create != 1 || !hasIssue(p.Report, "name_exists", SevWarning) {
		t.Fatalf("%+v", p.Report)
	}
}

func TestPlanIngredientsAssignsSKUToUniqueBlankSKUNameMatch(t *testing.T) {
	p := planIngredients(t, ingredientHeader+" ALKOHOL ,AL-1,ml,,,,\n")
	r := p.Report
	if r.HasErrors() || r.Summary.Update != 1 || r.Summary.Create != 0 || r.Summary.Warning != 0 {
		t.Fatalf("%+v %+v", r.Summary, r.Issues)
	}
	if len(p.Ingredients) != 1 || p.Ingredients[0].ExistingID != "i2" || p.Ingredients[0].SKU != "AL-1" {
		t.Fatalf("must update the existing blank-SKU ingredient: %+v", p.Ingredients)
	}
	if r.Rows[0].Action != ActionUpdate || !strings.Contains(r.Rows[0].Reason, "AL-1") || !strings.Contains(r.Rows[0].Reason, "ditetapkan") {
		t.Errorf("reason must note the SKU assignment: %+v", r.Rows[0])
	}
}

func TestPlanIngredientsSKUAssignNegativesKeepCreateWithWarning(t *testing.T) {
	// "Dup" matches two ingredients; "Rose Oil" matches one that already has another SKU.
	p := planIngredients(t, ingredientHeader+"Dup,DU-1,ml,,,,\nRose Oil,RO-NEW,g,,,,\n")
	r := p.Report
	if r.HasErrors() || r.Summary.Create != 2 || r.Summary.Update != 0 || r.Summary.Warning != 2 {
		t.Fatalf("%+v %+v", r.Summary, r.Issues)
	}
	for _, i := range p.Ingredients {
		if i.ExistingID != "" {
			t.Errorf("must stay a create: %+v", i)
		}
	}
	if got := issueCodes(r, SevWarning); len(got) != 2 || got[0] != "name_exists" || got[1] != "name_exists" {
		t.Errorf("warnings %v", got)
	}
}

func TestPlanIngredientsSKUAssignCannotRepeat(t *testing.T) {
	// the same SKU twice stays a duplicate_in_file error
	p := planIngredients(t, ingredientHeader+"Alkohol,AL-1,ml,,,,\nAlkohol,al-1,ml,,,,\n")
	if !hasIssue(p.Report, "duplicate_in_file", SevError) {
		t.Fatalf("%+v", p.Report.Issues)
	}
	// two different SKUs for the same ingredient: only the first assigns, the second is a new ingredient
	p = planIngredients(t, ingredientHeader+"Alkohol,AL-1,ml,,,,\nAlkohol,AL-2,ml,,,,\n")
	r := p.Report
	if r.HasErrors() || r.Summary.Update != 1 || r.Summary.Create != 1 || r.Summary.Warning != 1 {
		t.Fatalf("%+v %+v", r.Summary, r.Issues)
	}
	updates := 0
	for _, i := range p.Ingredients {
		if i.ExistingID == "i2" {
			updates++
		}
	}
	if updates != 1 {
		t.Errorf("ingredient i2 must be written once, got %d", updates)
	}
}
