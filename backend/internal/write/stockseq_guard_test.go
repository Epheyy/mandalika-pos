package write

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// A15 Phase B guard. Every code path that writes outlet_variant_stock must either
// bump outlet_stock_seq (exactly once, as its LAST stock/version statement) or be
// listed here as a deliberate non-bumper. A new writer therefore cannot appear
// without somebody deciding which kind it is. The database trigger alternative was
// rejected (lock-order cycle with transfers and stock counts), so this test is the
// safety net; the PostgreSQL gate ST proves the counts end to end.
//
// Value = the file MUST call BumpStockSeq (true) or MUST NOT (false).
var stockSeqAllowlist = map[string]bool{
	// bumpers: sale, refund (RefundTx), transfers, goods receipt/adjust, stock count,
	// product-create seed
	"internal/service/order.go":    true,
	"internal/service/refund.go":   true,
	"internal/write/transfer.go":   true,
	"internal/write/warehouse.go":  true,
	"internal/write/stockcount.go": true,
	"internal/write/catalog.go":    true,
	// non-bumpers: stock unchanged (lazy zero row, rename, delete, par, availability)
	// or read-only
	"internal/service/lockorder.go":     false,
	"internal/write/import_products.go": false,
	// D13 guard: row locks and RETURNING checks around zero-stock deletes/moves only
	"internal/write/stock_guard.go": false,
	"internal/read/oversell.go":     false,
	"internal/read/catalog.go":      false,
	"internal/read/inventory.go":    false,
	"internal/read/skumapping.go":   false, // read-only has_stock check for the ERP mapping export
	// ledger reads (post-read / backfill lock); never writes stock (plan §2.5, D2b)
	"internal/ledger/ledger.go":   false,
	"internal/ledger/backfill.go": false,
	// reads stock to choose the restocked refund lines; never writes it (D2b)
	"internal/service/ledger_hooks.go": false,
	// read-only plan §2.4 invariant query of the ERP demo rehearsal (default_transaction_read_only)
	"cmd/erp-rehearsal/steps_check.go": false,
}

const stockTable = "outlet_variant_stock"

// afterBumpAllowed lists the only calls permitted after the bump in the same
// function: finish the transaction or build an error. Anything else (an Exec, a
// Query, a version bump, another stock helper) is more stock/version work after the
// bump and breaks the lock order content_versions -> outlet_stock_seq.
var afterBumpAllowed = map[string]bool{
	"Commit": true, "Rollback": true, "Errorf": true, "Wrap": true, "New": true,
	"Is": true, "As": true, "Join": true,
	"len": true, "cap": true, "append": true, "make": true, "new": true,
	"int": true, "int64": true, "int32": true, "string": true, "float64": true, "bool": true,
}

func calleeName(c *ast.CallExpr) string {
	switch f := c.Fun.(type) {
	case *ast.Ident:
		return f.Name
	case *ast.SelectorExpr:
		return f.Sel.Name
	}
	return ""
}

// checkBumpOrder parses one Go source and reports functions that call BumpStockSeq
// more than once or do anything but finish the transaction after it.
func checkBumpOrder(name, src string) []string {
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, name, src, 0)
	if err != nil {
		return []string{name + ": parse error: " + err.Error()}
	}
	var bad []string
	for _, d := range file.Decls {
		fn, ok := d.(*ast.FuncDecl)
		if !ok || fn.Body == nil {
			continue
		}
		var bumps []*ast.CallExpr
		ast.Inspect(fn.Body, func(n ast.Node) bool {
			if c, ok := n.(*ast.CallExpr); ok && calleeName(c) == "BumpStockSeq" {
				bumps = append(bumps, c)
			}
			return true
		})
		if len(bumps) == 0 {
			continue
		}
		if len(bumps) > 1 {
			bad = append(bad, name+": "+fn.Name.Name+" calls BumpStockSeq more than once")
		}
		last := bumps[0]
		for _, b := range bumps {
			if b.End() > last.End() {
				last = b
			}
		}
		ast.Inspect(fn.Body, func(n ast.Node) bool {
			c, ok := n.(*ast.CallExpr)
			if !ok || c.Pos() < last.End() {
				return true
			}
			if nm := calleeName(c); !afterBumpAllowed[nm] {
				p := fset.Position(c.Pos())
				bad = append(bad, name+": "+fn.Name.Name+" does work after BumpStockSeq: "+nm+" at line "+itoa(p.Line))
			}
			return true
		})
	}
	return bad
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for ; n > 0; n /= 10 {
		b = append([]byte{byte('0' + n%10)}, b...)
	}
	return string(b)
}

func backendRoot(t *testing.T) string {
	t.Helper()
	root, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "go.mod")); err != nil {
		t.Fatalf("backend root not found at %s: %v", root, err)
	}
	return root
}

// goSources returns the non-test, non-generated Go files under root, keyed by path
// relative to root with forward slashes.
func goSources(t *testing.T, root string) map[string]string {
	t.Helper()
	out := map[string]string{}
	err := filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		n := d.Name()
		if !strings.HasSuffix(n, ".go") || strings.HasSuffix(n, "_test.go") || n == "api.gen.go" {
			return nil
		}
		raw, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(root, p)
		out[filepath.ToSlash(rel)] = string(raw)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func callsBump(src string) bool {
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, "x.go", src, 0)
	if err != nil {
		return false
	}
	found := false
	ast.Inspect(file, func(n ast.Node) bool {
		if c, ok := n.(*ast.CallExpr); ok && calleeName(c) == "BumpStockSeq" {
			found = true
		}
		return !found
	})
	return found
}

func TestStockSeqEveryStockWriterIsClassified(t *testing.T) {
	root := backendRoot(t)
	srcs := goSources(t, root)
	var names []string
	for n := range srcs {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		src := srcs[n]
		mustBump, listed := stockSeqAllowlist[n]
		mentions := strings.Contains(src, stockTable)
		bumps := callsBump(src)
		switch {
		case mentions && !listed:
			t.Errorf("%s mentions %s but is not in stockSeqAllowlist: decide whether it bumps outlet_stock_seq (A15 Phase B)", n, stockTable)
		case bumps && !listed:
			t.Errorf("%s calls BumpStockSeq but is not in stockSeqAllowlist", n)
		case listed && !mentions:
			t.Errorf("%s is in stockSeqAllowlist but no longer mentions %s: remove the stale entry", n, stockTable)
		case listed && mustBump && !bumps:
			t.Errorf("%s writes stock and must call BumpStockSeq (as its last statement) but does not", n)
		case listed && !mustBump && bumps:
			t.Errorf("%s is listed as a non-bumper but calls BumpStockSeq", n)
		}
	}
	for n := range stockSeqAllowlist {
		if _, ok := srcs[n]; !ok {
			t.Errorf("stockSeqAllowlist names %s, which does not exist", n)
		}
	}
}

func TestStockSeqBumpIsTheLastWorkInEveryWriter(t *testing.T) {
	root := backendRoot(t)
	for n, src := range goSources(t, root) {
		if !strings.Contains(src, "BumpStockSeq") {
			continue
		}
		for _, v := range checkBumpOrder(n, src) {
			t.Error(v)
		}
	}
}

// The checker must really fail on bad shapes; a guard that cannot fail guards nothing.
func TestStockSeqGuardRejectsBadShapes(t *testing.T) {
	cases := []struct {
		name, src string
		wantBad   bool
	}{
		{"last then commit is fine", `package p
func f(ctx C, tx T) error {
	if _, err := tx.Exec(ctx, "UPDATE outlet_variant_stock"); err != nil { return err }
	if err := bumpVersionOutlets(ctx, tx); err != nil { return err }
	if _, err := BumpStockSeq(ctx, tx, "o"); err != nil { return fmt.Errorf("x: %w", err) }
	return tx.Commit(ctx)
}`, false},
		{"exec after the bump", `package p
func f(ctx C, tx T) error {
	if _, err := write.BumpStockSeq(ctx, tx, "o"); err != nil { return err }
	_, err := tx.Exec(ctx, "UPDATE outlet_variant_stock SET stock=1")
	return err
}`, true},
		{"version bump after the bump", `package p
func f(ctx C, tx T) error {
	_, _ = BumpStockSeq(ctx, tx, "o")
	return bumpVersion(ctx, tx, "products")
}`, true},
		{"stock helper after the bump", `package p
func f(ctx C, tx T) error {
	_, _ = BumpStockSeq(ctx, tx, "o")
	return addStockDelta(ctx, tx)
}`, true},
		{"two bumps", `package p
func f(ctx C, tx T) error {
	_, _ = BumpStockSeq(ctx, tx, "a")
	_, _ = BumpStockSeq(ctx, tx, "b")
	return tx.Commit(ctx)
}`, true},
		{"a function without a bump is ignored", `package p
func f(ctx C, tx T) error { _, err := tx.Exec(ctx, "x"); return err }`, false},
	}
	for _, c := range cases {
		got := checkBumpOrder(c.name, c.src)
		if (len(got) > 0) != c.wantBad {
			t.Errorf("%s: violations=%v wantBad=%v", c.name, got, c.wantBad)
		}
	}
}

// A trigger or SQL function that wrote outlet_variant_stock would change stock
// without this guard seeing it; none exists, none may be added silently.
func TestStockSeqNoSqlObjectWritesStock(t *testing.T) {
	root := backendRoot(t)
	files, err := filepath.Glob(filepath.Join(root, "internal", "db", "migrations", "*.sql"))
	if err != nil || len(files) == 0 {
		t.Fatalf("no migrations found: %v", err)
	}
	for _, f := range files {
		raw, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		low := strings.ToLower(string(raw))
		hasObject := strings.Contains(low, "create trigger") || strings.Contains(low, "create function") ||
			strings.Contains(low, "create or replace function") || strings.Contains(low, "create procedure")
		if hasObject && strings.Contains(low, stockTable) {
			t.Errorf("%s defines a trigger/function/procedure that mentions %s: it must bump outlet_stock_seq in its own writer and be added to this guard deliberately", filepath.Base(f), stockTable)
		}
	}
}

// ---- Per-file and per-caller pins (the allowlist above is per FILE; these close the gaps) ----
//
// A new stock writer inside an already-allowlisted file, a function that reaches stock
// only through a helper, or an outlet writer copy-pasted onto bumpOutletTx would pass the
// file-level checks. Pinning counts and callers makes every such addition fail HERE, so
// the next developer must decide: add the BumpStockSeq call (as the LAST statement, see
// stockseq.go) or, for a change that truly leaves stock unchanged, update the pin with a
// comment saying why.

const pinHint = "add a write.BumpStockSeq call as the LAST statement of the new writer's transaction (see write/stockseq.go), or, if stock is really unchanged, update this pin and say why in a comment"

var stockWriteSQL = regexp.MustCompile(`(?i)(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+outlet_variant_stock\b`)

// stockSQLPins: per file, the number of literal stock-write statements on
// outlet_variant_stock plus the dynamic-table references ("outlet_variant_stock" as a Go
// string value, used to build SQL for the outlet leg).
var stockSQLPins = map[string][2]int{
	"internal/service/order.go":     {2, 0}, // lazy row, decrement
	"internal/service/refund.go":    {1, 0}, // refund restock
	"internal/service/lockorder.go": {1, 0}, // lazy zero row (no bump)
	"internal/write/transfer.go":    {2, 0}, // addStockDelta, deductStockGuarded
	"internal/write/warehouse.go":   {3, 1}, // goods receipt (dynamic), adjust lazy zero row before the locked pre-read (ledger before/after; no qty change), adjust, par
	"internal/write/stockcount.go":  {0, 1}, // countLoc.stock()
	// seed, rename (D13: guarded zero-stock move, RETURNING check), delete variant (D13:
	// guarded zero-stock delete), availability, cleanup (D13: only stock = 0 rows of sizes
	// without a variant), DeleteProduct (D13: guarded zero-stock delete before the cascade)
	"internal/write/catalog.go":         {6, 0},
	"internal/write/import_products.go": {0, 1}, // rename only (no quantity change; D13 refuses a stocked key)
}

// stockHelperCallers: every stock-changing helper and the only functions allowed to call it.
var stockHelperCallers = map[string][]string{
	"addStockDelta":      {"cancelTransfer", "receiveTransfer"},
	"deductStockGuarded": {"sendTransfer"},
	"applyCountDeltas":   {"completeStockCount"},
	"seedOutletStock":    {"CreateProduct"},
	"bumpOutletTx":       {"SetOutletPar"}, // par level only: it must NOT carry a stock change
}

func countStockSQL(src string) (literal, dynamic int) {
	return len(stockWriteSQL.FindAllString(src, -1)), strings.Count(src, `"outlet_variant_stock"`)
}

// helperCallers returns "Func" names (sorted, deduped) that call any helper in names.
func helperCallers(name, src string, names map[string]bool) map[string][]string {
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, name, src, 0)
	out := map[string][]string{}
	if err != nil {
		return out
	}
	for _, d := range file.Decls {
		fn, ok := d.(*ast.FuncDecl)
		if !ok || fn.Body == nil {
			continue
		}
		seen := map[string]bool{}
		ast.Inspect(fn.Body, func(n ast.Node) bool {
			if c, ok := n.(*ast.CallExpr); ok && names[calleeName(c)] && !seen[calleeName(c)] {
				seen[calleeName(c)] = true
				out[calleeName(c)] = append(out[calleeName(c)], fn.Name.Name)
			}
			return true
		})
	}
	return out
}

func TestStockSeqStockSQLCountsArePinned(t *testing.T) {
	srcs := goSources(t, backendRoot(t))
	for n, src := range srcs {
		lit, dyn := countStockSQL(src)
		if lit == 0 && dyn == 0 {
			continue
		}
		pin, ok := stockSQLPins[n]
		if !ok {
			t.Errorf("%s has %d stock-write statements / %d dynamic references but no pin: %s", n, lit, dyn, pinHint)
			continue
		}
		if lit != pin[0] || dyn != pin[1] {
			t.Errorf("%s: stock-write SQL changed (literal %d, dynamic %d; pinned %d, %d): %s", n, lit, dyn, pin[0], pin[1], pinHint)
		}
	}
	for n := range stockSQLPins {
		if _, ok := srcs[n]; !ok {
			t.Errorf("stockSQLPins names %s, which does not exist", n)
		}
	}
}

func TestStockSeqHelperCallersArePinned(t *testing.T) {
	names := map[string]bool{}
	for h := range stockHelperCallers {
		names[h] = true
	}
	got := map[string][]string{}
	for n, src := range goSources(t, backendRoot(t)) {
		for h, fns := range helperCallers(n, src, names) {
			got[h] = append(got[h], fns...)
		}
	}
	for h, want := range stockHelperCallers {
		g := append([]string(nil), got[h]...)
		sort.Strings(g)
		if strings.Join(g, ",") != strings.Join(want, ",") {
			t.Errorf("callers of %s are %v, pinned %v: %s", h, g, want, pinHint)
		}
	}
}

func TestStockSeqPinsRejectBadShapes(t *testing.T) {
	if lit, dyn := countStockSQL("x := `UPDATE outlet_variant_stock SET stock=1`\ny := \"outlet_variant_stock\""); lit != 1 || dyn != 1 {
		t.Fatalf("count lit=%d dyn=%d", lit, dyn)
	}
	src := `package p
func newWriter(ctx C, tx T) error { return addStockDelta(ctx, tx) }
func parCopy(r R) error { return r.bumpOutletTx(ctx, "o", nil) }
func ok() { other() }`
	got := helperCallers("x.go", src, map[string]bool{"addStockDelta": true, "bumpOutletTx": true})
	if len(got["addStockDelta"]) != 1 || got["addStockDelta"][0] != "newWriter" || len(got["bumpOutletTx"]) != 1 {
		t.Fatalf("callers %v", got)
	}
}
