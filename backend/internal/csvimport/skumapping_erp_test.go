package csvimport

import (
	"encoding/json"
	"fmt"
	"os"
	"slices"
	"strings"
	"testing"
)

// The cutover mapping file on real data: the 29 real POS variants of test Neon (sandbox
// report 2026-10-26 §2) against the production ERP rows (erpmap testdata). 22 rows are
// clean, 3 conflict (KEM-CAN name; the hampers HAME-THE and HAMP-THE name and label), and
// the 4 wrong POS SKUs PW110E/P-NO1 and PW110E/P-ONL are corrected to the ERP's PP120 codes.

type erpSampleFG struct {
	Slug, Code, Name string
	Category         *string
	Size             *float64
	IsOthers         bool `json:"is_others"`
}

func loadERPSample(t *testing.T) map[string]erpSampleFG {
	t.Helper()
	b, err := os.ReadFile("../integration/erp/erpmap/testdata/fg_sample_2026-10-26.json")
	if err != nil {
		t.Fatal(err)
	}
	var doc struct{ Items []erpSampleFG }
	if err := json.Unmarshal(b, &doc); err != nil {
		t.Fatal(err)
	}
	out := map[string]erpSampleFG{}
	for _, fg := range doc.Items {
		out[fg.Code] = fg
	}
	return out
}

// posRow is one real POS variant and the ERP code the mapping file gives it.
type posRow struct{ product, key, size, sku, fgCode string }

func testNeonRows() []posRow {
	var rows []posRow
	for _, fc := range []string{"GOR", "HOL", "UNS", "NO1", "ONL"} {
		name := map[string]string{"GOR": "GORGEOUS TUBEROSE", "HOL": "HOLY SWEET", "UNS": "UNSTOPPABLE",
			"NO1": "NO1", "ONL": "ONLY THE BRAVE"}[fc]
		big, pe, pp := "110ml", "PW110E-"+fc, "PW110P-"+fc
		fe, fp := pe, pp
		if fc == "NO1" || fc == "ONL" {
			big, fe, fp = "120ml", "PP120E-"+fc, "PP120P-"+fc // the POS codes are wrong; the ERP holds PP120
		}
		key := "erp:" + fc
		rows = append(rows,
			posRow{name, key, "10ml ATOMIZER", "A10M-" + fc, "A10M-" + fc},
			posRow{name, key, big + " EXTRAIT DE PARFUM", pe, fe},
			posRow{name, key, big + " PARFUM INTENSE", pp, fp},
			posRow{name, key, "2ml EXTRAIT DE PARFUM", "V2E-" + fc, "V2E-" + fc},
			posRow{name, key, "2ml PARFUM INTENSE", "V2P-" + fc, "V2P-" + fc})
	}
	return append(rows,
		posRow{"THE ONLY ONE", "erp:HAMPERS-THE", "EXTRAIT DE PARFUM", "HAME-THE", "HAME-THE"},
		posRow{"THE ONLY ONE", "erp:HAMPERS-THE", "PARFUM INTENSE", "HAMP-THE", "HAMP-THE"},
		posRow{"CANVAS BAG", "erp:KEM-CAN", "Satuan", "KEM-CAN", "KEM-CAN"},
		posRow{"KARTU GARANSI", "erp:KEM-KAR", "Satuan", "KEM-KAR", "KEM-KAR"})
}

func TestPlanSkuMappingRealCutoverFile(t *testing.T) {
	erp := loadERPSample(t)
	rows := testNeonRows()
	cat := SkuMappingCatalog{GroupKeys: map[string]string{}, GroupKeyOwners: map[string]string{}}
	var csv strings.Builder
	csv.WriteString("variant_id,product,size,sku,has_stock,barcode,fg_code,fg_slug,erp_group_key,fg_name,fg_category,fg_size,fg_is_others\n")
	for _, r := range rows {
		pid := "p-" + r.product
		cat.Variants = append(cat.Variants, SkuMappingVariant{ID: "v-" + r.sku, ProductID: pid, SKU: r.sku, ProductName: r.product, Size: r.size})
		cat.GroupKeys[pid] = ""
		fg, ok := erp[r.fgCode]
		if !ok {
			t.Fatalf("ERP sample lacks %s", r.fgCode)
		}
		fmt.Fprintf(&csv, "v-%s,%s,%s,%s,false,%s,%s,%s,%s,%s,%s,%v,%v\n", r.sku, r.product, r.size, r.sku, r.sku,
			fg.Code, fg.Slug, r.key, fg.Name, *fg.Category, *fg.Size, fg.IsOthers)
	}
	p, err := PlanSkuMapping(Read([]byte(csv.String()), SkuMappingSpec), cat)
	if err != nil {
		t.Fatal(err)
	}
	if p.Report.HasErrors() || p.Report.Summary.Update != 29 {
		t.Fatalf("summary %+v, issues %+v", p.Report.Summary, p.Report.Issues)
	}
	byCode := map[string][]string{}
	for _, is := range p.Report.Issues {
		sku := rows[is.Row-1].sku
		byCode[is.Code] = append(byCode[is.Code], sku)
		if is.Severity != SevWarning {
			t.Fatalf("issue %+v must be a warning", is)
		}
	}
	for code, want := range map[string][]string{
		"name_conflict":  {"HAME-THE", "HAMP-THE", "KEM-CAN"},
		"label_conflict": {"HAME-THE", "HAMP-THE"},
		"sku_changed":    {"PW110E-NO1", "PW110E-ONL", "PW110P-NO1", "PW110P-ONL"},
	} {
		got := byCode[code]
		slices.Sort(got)
		if strings.Join(got, ",") != strings.Join(want, ",") {
			t.Errorf("%s rows = %v, want %v", code, got, want)
		}
		delete(byCode, code)
	}
	if len(byCode) > 0 {
		t.Errorf("unexpected issues: %v", byCode)
	}
	corrected := map[string]string{}
	for _, m := range p.Mappings {
		if m.OldSKU != m.FGCode {
			corrected[m.OldSKU] = m.FGCode
		}
	}
	if want := map[string]string{"PW110E-NO1": "PP120E-NO1", "PW110P-NO1": "PP120P-NO1",
		"PW110E-ONL": "PP120E-ONL", "PW110P-ONL": "PP120P-ONL"}; fmt.Sprint(corrected) != fmt.Sprint(want) {
		t.Errorf("SKU corrections = %v, want %v", corrected, want)
	}
	for _, is := range p.Report.Issues {
		if is.Code == "label_conflict" && !strings.Contains(is.Message, `"Satuan"`) {
			t.Errorf("label conflict message must name the ERP label: %s", is.Message)
		}
	}
}

func TestPlanSkuMappingERPContextIsOptional(t *testing.T) {
	p := planSkuMap(t, skuMapHeader+"v1,A,50ml,SKU-1,false,SKU-1,SKU-1,slug-1,\n")
	if len(p.Report.Issues) != 0 || p.Report.Summary.Update != 1 {
		t.Fatalf("no context columns: no checks, got %+v", p.Report.Issues)
	}
}
