package csvimport

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// KindStockCount is the scanner CSV upload of an in-progress stock count (inventory S4). The
// kind string matches migration 0073's import_runs.kind check.
const KindStockCount = "stock_count"

// MaxCountedQty bounds one summed counted quantity (a scanner app cannot count past this).
const MaxCountedQty = 1_000_000

// maxUncountedListed caps the uncounted list in the report (the summary counter stays exact).
const maxUncountedListed = MaxIssues

// StockCountSpec is the layout of a scanner file: barcode or sku (at least one per row) and
// counted_qty. product, size and expected_qty are the export's context columns: read and
// ignored, declared so the exported sheet re-uploads without an "unknown column" warning.
var StockCountSpec = Spec{
	Columns: []ColumnSpec{
		{Key: "barcode"},
		{Key: "sku"},
		{Key: "counted_qty", Aliases: []string{"qty", "quantity", "jumlah"}, Required: true},
		{Key: "product"},
		{Key: "size"},
		{Key: "expected_qty"},
	},
}

// Row-level warning names (the contract's StockCountImportWarning enum).
const (
	WarnUnknownCode          = "unknown_code"
	WarnAmbiguousSKU         = "ambiguous_sku"
	WarnNotOnCount           = "not_on_count"
	WarnStockMovedSinceStart = "stock_moved_since_start"
	WarnBaselineReplaced     = "baseline_replaced"
	WarnSKUNarrowed          = "sku_narrowed"
)

// StockCountSummary holds the exact counters of one count import. The commit must send the
// preview's summary back; any difference at commit time is a stale preview (409).
type StockCountSummary struct {
	Matched    int `json:"matched"`
	Unknown    int `json:"unknown"`
	Ambiguous  int `json:"ambiguous"`
	NotOnCount int `json:"notOnCount"`
	Uncounted  int `json:"uncounted"`
	Changed    int `json:"changed"`
	// Digest is server-computed over the matched lines (see planDigest). A commit must send the
	// preview's value back: a manual save or a stock movement in between changes it (409).
	Digest string `json:"digest"`
}

// StockCountLineRef names one line of the count.
type StockCountLineRef struct {
	ProductID   string `json:"productId"`
	VariantSize string `json:"variantSize"`
	ProductName string `json:"productName,omitempty"`
	SKU         string `json:"sku,omitempty"`
}

// StockCountRow is one scanned code after repeated scans of it were summed.
type StockCountRow struct {
	Row         int                `json:"row"`
	Code        string             `json:"code"`
	MatchedLine *StockCountLineRef `json:"matchedLine,omitempty"`
	Expected    *int               `json:"expected,omitempty"`
	Counted     int                `json:"counted"`
	Previous    *int               `json:"previous,omitempty"`
	Difference  *int               `json:"difference,omitempty"`
	Warnings    []string           `json:"warnings"`
}

// StockCountReport is the one shape shared by preview, apply (200), 422 and replay.
type StockCountReport struct {
	Kind       string              `json:"kind"`
	Delimiter  string              `json:"delimiter"`
	FileSHA256 string              `json:"fileSha256"`
	TotalRows  int                 `json:"totalRows"`
	Summary    StockCountSummary   `json:"summary"`
	FileIssues []FileIssue         `json:"fileIssues"`
	Issues     []Issue             `json:"issues"`
	Rows       []StockCountRow     `json:"rows"`
	Uncounted  []StockCountLineRef `json:"uncounted"`
	RunID      string              `json:"runId,omitempty"`
	AppliedAt  string              `json:"appliedAt,omitempty"`

	errorRows int // rows with an error issue (not serialised; the planner's refusal signal)
}

// HasErrors is true when apply must be refused: a file-level error, an errored row, or a
// code that is unknown or ambiguous.
func (r StockCountReport) HasErrors() bool {
	if r.errorRows > 0 || r.Summary.Unknown > 0 || r.Summary.Ambiguous > 0 {
		return true
	}
	for _, f := range r.FileIssues {
		if f.Severity == SevError {
			return true
		}
	}
	return false
}

// Redacted is the copy kept in the audit table: codes are catalog data, but the issue value
// can echo a stray cell of the file, so it is dropped (like Report.Redacted).
func (r StockCountReport) Redacted() StockCountReport {
	out := r
	out.Issues = make([]Issue, len(r.Issues))
	for i, is := range r.Issues {
		is.Value = ""
		out.Issues[i] = is
	}
	out.FileIssues = append([]FileIssue{}, r.FileIssues...)
	return out
}

// StockCountLine is one line of the count as the planner sees it. Actual is the value
// already stored (nil = not counted yet); Moved says the ledger recorded a movement of the
// variant after the count started.
type StockCountLine struct {
	ProductID, VariantSize, ProductName, SKU string
	Frozen                                   int
	Actual                                   *int
	Moved                                    bool
	// HasBaseline: the line carries a per-line baseline from a manual save. A CSV save that changes
	// the value clears it (the CSV measures against the count-start snapshot), so the preview flags it.
	HasBaseline bool
}

// StockCountVariant is one catalog variant a scanned code can resolve to.
type StockCountVariant struct{ ProductID, Size, SKU, Barcode string }

// StockCountCatalog is the snapshot the planner checks the file against.
type StockCountCatalog struct {
	Lines    []StockCountLine
	Variants []StockCountVariant
}

// StockCountSave is one counted quantity to store on a line.
type StockCountSave struct {
	ProductID, VariantSize string
	Qty                    int
}

// StockCountPlan is the outcome of planning a scanner file. Saves is every matched line (an
// unchanged value is harmless: the save keeps its baseline and timestamp).
type StockCountPlan struct {
	Report StockCountReport
	Saves  []StockCountSave
}

var digitsQty = regexp.MustCompile(`^\d{1,9}$`)

type lineKey [2]string

// scanGroup is one distinct scanned code with its summed quantity.
type scanGroup struct {
	row        Row // the first row that carried the code
	code       string
	viaBarcode bool
	fallback   string // the row's sku when the code is a barcode (used only if the barcode is unknown)
	qty        int
	qtyBad     bool
}

type countIndex struct {
	byBarcode map[string]*StockCountVariant
	bySKU     map[string][]*StockCountVariant
	lines     map[lineKey]*StockCountLine
}

func newCountIndex(cat StockCountCatalog) *countIndex {
	ix := &countIndex{byBarcode: map[string]*StockCountVariant{}, bySKU: map[string][]*StockCountVariant{},
		lines: map[lineKey]*StockCountLine{}}
	for i := range cat.Variants {
		v := &cat.Variants[i]
		if v.Barcode != "" {
			ix.byBarcode[v.Barcode] = v
		}
		if v.SKU != "" {
			ix.bySKU[v.SKU] = append(ix.bySKU[v.SKU], v)
		}
	}
	for i := range cat.Lines {
		l := &cat.Lines[i]
		ix.lines[lineKey{l.ProductID, l.VariantSize}] = l
	}
	return ix
}

const (
	resolved = iota
	unknownCode
	ambiguousCode
	resolvedNarrowed // a shared SKU matched to the one line that is on this count
)

// resolve maps a scanned code to one variant. A barcode (the column wins when the row has
// both) is unique by index; if the barcode is unknown the row's sku, when given, is tried.
// A SKU shared by several variants is ambiguous: nothing is guessed.
func (ix *countIndex) resolve(g *scanGroup) (*StockCountVariant, int) {
	if g.viaBarcode {
		if v := ix.byBarcode[g.code]; v != nil {
			return v, resolved
		}
		if g.fallback == "" {
			return nil, unknownCode
		}
		return ix.bySKUCode(g.fallback)
	}
	return ix.bySKUCode(g.code)
}

// bySKUCode resolves a SKU. A SKU shared by several variants is first narrowed to the count's
// own lines: only if that still leaves several (or none, with several elsewhere) is it ambiguous.
func (ix *countIndex) bySKUCode(sku string) (*StockCountVariant, int) {
	vs := ix.bySKU[sku]
	var onCount []*StockCountVariant
	for _, v := range vs {
		if ix.lines[lineKey{v.ProductID, v.Size}] != nil {
			onCount = append(onCount, v)
		}
	}
	switch {
	case len(onCount) == 1:
		if len(vs) > 1 {
			return onCount[0], resolvedNarrowed
		}
		return onCount[0], resolved
	case len(onCount) > 1:
		return nil, ambiguousCode
	case len(vs) == 0:
		return nil, unknownCode
	case len(vs) == 1:
		return vs[0], resolved // a real variant that is not on this count
	}
	return nil, ambiguousCode
}

// PlanStockCount validates a scanner file against the count's lines and the catalog. Repeated
// scans of one code are summed. Unknown codes, ambiguous SKUs, bad quantities and two codes
// that point at the same line are errors (the whole file applies or none of it); a code that
// is not a line of the count is a warning and is not stored. Lines absent from the file keep
// whatever they hold; the ones still never counted are listed in the report.
func PlanStockCount(t *Table, cat StockCountCatalog) *StockCountPlan {
	b := NewBuilder(KindStockCount, t)
	plan := &StockCountPlan{}
	rep := StockCountReport{Kind: KindStockCount, Delimiter: t.Delimiter, FileSHA256: t.SHA256,
		TotalRows: len(t.Rows), Rows: []StockCountRow{}, Uncounted: []StockCountLineRef{}}
	if t.HasFileError() {
		rep.FileIssues, rep.Issues = b.Report().FileIssues, []Issue{}
		plan.Report = rep
		return plan
	}
	groups, order := groupScans(b, t, &rep)
	ix := newCountIndex(cat)
	matched := map[lineKey]int{} // matched line -> its planned quantity
	for _, gk := range order {
		g := groups[gk]
		if g.qtyBad {
			continue // its row already carries the quantity error
		}
		planGroup(b, &rep, plan, ix, matched, g)
	}
	listUncounted(&rep, cat, matched)
	rep.Summary.Digest = planDigest(cat, matched)
	fin := b.Report()
	rep.FileIssues, rep.Issues = fin.FileIssues, fin.Issues
	plan.Report = rep
	return plan
}

// groupScans reads every row into per-code groups (first-seen order), checking the cells.
func groupScans(b *Builder, t *Table, rep *StockCountReport) (map[string]*scanGroup, []string) {
	groups := map[string]*scanGroup{}
	var order []string
	for _, row := range t.Rows {
		b.Begin(row)
		barcode, sku := strings.TrimSpace(row.Cells["barcode"]), strings.TrimSpace(row.Cells["sku"])
		code, viaBarcode := sku, false
		if barcode != "" {
			code, viaBarcode = barcode, true
		}
		if code != "" && strings.TrimSpace(row.Cells["counted_qty"]) == "" {
			// A partly filled sheet: counting by section leaves the other rows blank.
			b.Issue(row, "counted_qty", SevWarning, "blank_qty", "qty kosong, baris dilewati", code)
			continue
		}
		qty, qerr := parseCountedQty(row.Cells["counted_qty"])
		switch {
		case code == "":
			b.Issue(row, "barcode", SevError, "missing_code", "barcode atau sku wajib diisi", "")
		case len([]rune(code)) > MaxCode:
			b.Issue(row, "barcode", SevError, "too_long", fmt.Sprintf("kode terlalu panjang (maksimum %d karakter)", MaxCode), code)
		}
		if qerr != nil {
			b.Issue(row, "counted_qty", SevError, "invalid_qty", "counted_qty: "+qerr.Error(), row.Cells["counted_qty"])
		}
		if b.RowHasError(row) {
			rep.errorRows++
			continue
		}
		gk := "s:" + code // a barcode and a SKU with the same text are different keys
		if viaBarcode {
			gk = "b:" + code
		}
		g := groups[gk]
		if g == nil {
			g = &scanGroup{row: row, code: code, viaBarcode: viaBarcode, fallback: sku}
			if !viaBarcode {
				g.fallback = ""
			}
			groups[gk], order = g, append(order, gk)
		}
		g.qty += qty
		if g.qty > MaxCountedQty {
			b.Issue(row, "counted_qty", SevError, "qty_too_large",
				fmt.Sprintf("jumlah hasil penjumlahan melebihi %d", MaxCountedQty), code)
			rep.errorRows++
			g.qtyBad = true
		}
	}
	return groups, order
}

func parseCountedQty(s string) (int, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, fmt.Errorf("wajib diisi")
	}
	if !digitsQty.MatchString(s) {
		return 0, fmt.Errorf("harus bilangan bulat 0 atau lebih")
	}
	n, _ := strconv.Atoi(s)
	return n, nil
}

// planGroup resolves one summed code and records its row, counters and (when it matched a
// line of the count) the save.
func planGroup(b *Builder, rep *StockCountReport, plan *StockCountPlan, ix *countIndex, matched map[lineKey]int, g *scanGroup) {
	row := StockCountRow{Row: g.row.Index, Code: g.code, Counted: g.qty, Warnings: []string{}}
	v, status := ix.resolve(g)
	switch status {
	case unknownCode:
		rep.Summary.Unknown++
		row.Warnings = append(row.Warnings, WarnUnknownCode)
		b.Issue(g.row, "barcode", SevError, WarnUnknownCode, "kode tidak dikenal (bukan barcode atau SKU mana pun)", g.code)
	case ambiguousCode:
		rep.Summary.Ambiguous++
		row.Warnings = append(row.Warnings, WarnAmbiguousSKU)
		b.Issue(g.row, "sku", SevError, WarnAmbiguousSKU, "SKU dipakai lebih dari satu varian; pakai barcode", g.code)
	default:
		if status == resolvedNarrowed {
			row.Warnings = append(row.Warnings, WarnSKUNarrowed)
			b.Issue(g.row, "sku", SevWarning, WarnSKUNarrowed, "SKU dipakai beberapa produk; dicocokkan ke baris di opname ini", g.code)
		}
		planMatched(b, rep, plan, ix, matched, g, v, &row)
	}
	if len(rep.Rows) < MaxReportRows {
		rep.Rows = append(rep.Rows, row)
	}
}

func planMatched(b *Builder, rep *StockCountReport, plan *StockCountPlan, ix *countIndex, matched map[lineKey]int,
	g *scanGroup, v *StockCountVariant, row *StockCountRow) {
	k := lineKey{v.ProductID, v.Size}
	line := ix.lines[k]
	if line == nil {
		rep.Summary.NotOnCount++
		row.Warnings = append(row.Warnings, WarnNotOnCount)
		b.Issue(g.row, "barcode", SevWarning, WarnNotOnCount, "kode bukan bagian dari stock count ini; tidak disimpan", g.code)
		return
	}
	if _, dup := matched[k]; dup {
		rep.errorRows++
		b.Issue(g.row, "barcode", SevError, "duplicate_line",
			"dua kode berbeda menunjuk ke varian yang sama; gabungkan jumlahnya di file", g.code)
		return
	}
	matched[k] = g.qty
	rep.Summary.Matched++
	expected, diff := line.Frozen, g.qty-line.Frozen
	row.MatchedLine = &StockCountLineRef{ProductID: line.ProductID, VariantSize: line.VariantSize,
		ProductName: line.ProductName, SKU: line.SKU}
	row.Expected, row.Difference, row.Previous = &expected, &diff, line.Actual
	if line.Actual == nil || *line.Actual != g.qty {
		rep.Summary.Changed++
		if line.HasBaseline && line.Actual != nil {
			row.Warnings = append(row.Warnings, WarnBaselineReplaced)
			b.Issue(g.row, "barcode", SevWarning, WarnBaselineReplaced, "baseline input manual akan diganti snapshot awal opname", g.code)
		}
	}
	if line.Moved {
		row.Warnings = append(row.Warnings, WarnStockMovedSinceStart)
		b.Issue(g.row, "barcode", SevWarning, WarnStockMovedSinceStart, "stok bergerak sejak opname dimulai", g.code)
	}
	plan.Saves = append(plan.Saves, StockCountSave{ProductID: line.ProductID, VariantSize: line.VariantSize, Qty: g.qty})
}

// listUncounted lists the count lines absent from the file that are still not counted. The
// counter is exact; the list is capped.
func listUncounted(rep *StockCountReport, cat StockCountCatalog, matched map[lineKey]int) {
	for _, l := range cat.Lines {
		if _, ok := matched[lineKey{l.ProductID, l.VariantSize}]; ok || l.Actual != nil {
			continue
		}
		rep.Summary.Uncounted++
		if len(rep.Uncounted) < maxUncountedListed {
			rep.Uncounted = append(rep.Uncounted, StockCountLineRef{ProductID: l.ProductID, VariantSize: l.VariantSize,
				ProductName: l.ProductName, SKU: l.SKU})
		}
	}
}

// planDigest hashes what a preview saw of every matched line: its stored counted value, whether it
// carries a manual baseline, the quantity planned for it (so a catalog barcode swap changes the
// digest), and whether stock moved since the count started. The commit recomputes
// it, so a manual save or a new movement between preview and commit is a stale preview even when the
// counters are unchanged. Sorted by line, so the file's row order does not matter.
func planDigest(cat StockCountCatalog, matched map[lineKey]int) string {
	var parts []string
	for _, l := range cat.Lines {
		qty, ok := matched[lineKey{l.ProductID, l.VariantSize}]
		if !ok {
			continue
		}
		prev := "-"
		if l.Actual != nil {
			prev = strconv.Itoa(*l.Actual)
		}
		parts = append(parts, fmt.Sprintf("%s|%s|%s|%d|%t|%t", l.ProductID, l.VariantSize, prev, qty, l.HasBaseline, l.Moved))
	}
	sort.Strings(parts)
	sum := sha256.Sum256([]byte(strings.Join(parts, "\n")))
	return hex.EncodeToString(sum[:])
}
