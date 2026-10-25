package csvimport

import "testing"

func iptr(n int) *int { return &n }

func countCatalog() StockCountCatalog {
	return StockCountCatalog{
		Lines: []StockCountLine{
			{ProductID: "p1", VariantSize: "M", ProductName: "A", SKU: "A-M", Frozen: 10},
			{ProductID: "p1", VariantSize: "L", ProductName: "A", SKU: "A-L", Frozen: 5, Actual: iptr(4), Moved: true},
			{ProductID: "p2", VariantSize: "M", ProductName: "B", SKU: "B-M", Frozen: 3},
		},
		Variants: []StockCountVariant{
			{ProductID: "p1", Size: "M", SKU: "A-M", Barcode: "111"},
			{ProductID: "p1", Size: "L", SKU: "A-L", Barcode: "112"},
			{ProductID: "p2", Size: "M", SKU: "B-M", Barcode: "222"},
			{ProductID: "p3", Size: "M", SKU: "DUP", Barcode: "333"},
			{ProductID: "p4", Size: "M", SKU: "DUP", Barcode: "444"},
		},
	}
}

func plan(csv string) *StockCountPlan {
	return PlanStockCount(Read([]byte(csv), StockCountSpec), countCatalog())
}

func TestPlanStockCountSumsRepeatedScansAndBarcodeWins(t *testing.T) {
	p := plan("barcode,sku,counted_qty\n111,,1\n111,,2\n,A-L,4\n222,WRONG,3\n")
	if p.Report.HasErrors() {
		t.Fatalf("unexpected errors: %+v", p.Report.Issues)
	}
	s := p.Report.Summary
	if s.Matched != 3 || s.Changed != 2 || s.Uncounted != 0 {
		t.Fatalf("summary %+v", s)
	}
	if len(p.Saves) != 3 || p.Saves[0].Qty != 3 {
		t.Fatalf("saves %+v", p.Saves)
	}
	r := p.Report.Rows[0]
	if r.Counted != 3 || *r.Expected != 10 || *r.Difference != -7 || r.Previous != nil {
		t.Fatalf("row %+v", r)
	}
	if got := p.Report.Rows[1]; got.Previous == nil || *got.Previous != 4 || len(got.Warnings) != 1 || got.Warnings[0] != WarnStockMovedSinceStart {
		t.Fatalf("moved row %+v", got)
	}
}

func TestPlanStockCountErrorsAndWarnings(t *testing.T) {
	p := plan("barcode,sku,counted_qty\n999,,1\n,DUP,1\n,B-M,x\n,,2\n")
	if !p.Report.HasErrors() || p.Report.Summary.Unknown != 1 || p.Report.Summary.Ambiguous != 1 {
		t.Fatalf("report %+v", p.Report.Summary)
	}
	w := plan("barcode,counted_qty\n333,2\n111,1\n")
	if w.Report.HasErrors() || w.Report.Summary.NotOnCount != 1 || w.Report.Summary.Uncounted != 1 || len(w.Report.Uncounted) != 1 {
		t.Fatalf("warn report %+v", w.Report.Summary)
	}
	if len(w.Saves) != 1 {
		t.Fatalf("not-on-count code must not be saved: %+v", w.Saves)
	}
}

func TestPlanStockCountTwoCodesSameLineAndFileErrors(t *testing.T) {
	if p := plan("barcode,sku,counted_qty\n111,,1\n,A-M,1\n"); !p.Report.HasErrors() {
		t.Fatal("two codes for one line must be refused")
	}
	if p := plan("barcode,sku\n111,A\n"); !p.Report.HasErrors() {
		t.Fatal("missing counted_qty column must be a file error")
	}
}

func TestPlanStockCountBlankQtySkipsTheRowAndKeepsTheRest(t *testing.T) {
	p := plan("barcode,counted_qty\n111,\n112,4\n222, \n")
	if p.Report.HasErrors() {
		t.Fatalf("a blank qty must not block the upload: %+v", p.Report.Issues)
	}
	if p.Report.Summary.Matched != 1 || len(p.Saves) != 1 || p.Saves[0].Qty != 4 {
		t.Fatalf("summary %+v saves %+v", p.Report.Summary, p.Saves)
	}
	var skipped int
	for _, is := range p.Report.Issues {
		if is.Code == "blank_qty" && is.Severity == SevWarning {
			skipped++
		}
	}
	if skipped != 2 || p.Report.Summary.Uncounted != 2 {
		t.Fatalf("skipped %d uncounted %d", skipped, p.Report.Summary.Uncounted)
	}
}

func TestPlanStockCountSkuNarrowsToTheCountsOwnLines(t *testing.T) {
	cat := countCatalog()
	cat.Variants = append(cat.Variants, StockCountVariant{ProductID: "p1", Size: "M", SKU: "SHARED", Barcode: "1"},
		StockCountVariant{ProductID: "p9", Size: "M", SKU: "SHARED", Barcode: "2"})
	p := PlanStockCount(Read([]byte("sku,counted_qty\nSHARED,2\n"), StockCountSpec), cat)
	if p.Report.HasErrors() || p.Report.Summary.Matched != 1 || p.Report.Summary.Ambiguous != 0 {
		t.Fatalf("shared SKU with one variant on the count must resolve: %+v", p.Report.Summary)
	}
}

func TestPlanStockCountFlagsAManualBaselineThatTheCsvWillClear(t *testing.T) {
	cat := countCatalog()
	cat.Lines[0].Actual, cat.Lines[0].HasBaseline = iptr(3), true
	p := PlanStockCount(Read([]byte("barcode,counted_qty\n111,8\n"), StockCountSpec), cat)
	if w := p.Report.Rows[0].Warnings; len(w) != 1 || w[0] != WarnBaselineReplaced {
		t.Fatalf("warnings %v", w)
	}
	same := PlanStockCount(Read([]byte("barcode,counted_qty\n111,3\n"), StockCountSpec), cat)
	if len(same.Report.Rows[0].Warnings) != 0 {
		t.Fatalf("an unchanged value keeps its baseline, no warning: %v", same.Report.Rows[0].Warnings)
	}
}

func TestPlanStockCountDigestTracksLineStateNotFileOrder(t *testing.T) {
	a := plan("barcode,counted_qty\n111,1\n222,2\n").Report.Summary.Digest
	b := plan("barcode,counted_qty\n222,2\n111,1\n").Report.Summary.Digest
	if a == "" || a != b {
		t.Fatalf("digest must ignore row order: %q %q", a, b)
	}
	cat := countCatalog()
	cat.Lines[0].Actual = iptr(99) // a manual save between preview and commit
	if c := PlanStockCount(Read([]byte("barcode,counted_qty\n111,1\n222,2\n"), StockCountSpec), cat).Report.Summary.Digest; c == a {
		t.Fatal("digest must change when a matched line's stored value changes")
	}
	cat = countCatalog()
	cat.Lines[0].Moved = true // a new movement
	if c := PlanStockCount(Read([]byte("barcode,counted_qty\n111,1\n222,2\n"), StockCountSpec), cat).Report.Summary.Digest; c == a {
		t.Fatal("digest must change when stock moved")
	}
}

func TestPlanStockCountBarcodeAndSkuWithSameTextAreDifferentCodes(t *testing.T) {
	cat := countCatalog()
	cat.Variants[2].Barcode = "A-M" // p2/M's barcode equals p1/M's SKU text
	p := PlanStockCount(Read([]byte("barcode,sku,counted_qty\nA-M,,1\n,A-M,2\n"), StockCountSpec), cat)
	if p.Report.HasErrors() || p.Report.Summary.Matched != 2 || len(p.Report.Rows) != 2 {
		t.Fatalf("barcode A-M and sku A-M are two codes: %+v %+v", p.Report.Summary, p.Report.Issues)
	}
}
