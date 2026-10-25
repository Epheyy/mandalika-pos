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
