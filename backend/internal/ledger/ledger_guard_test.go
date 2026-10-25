package ledger

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// Ledger guards (plan §2.1, §2.5). stock_movements is append-only, and every code path
// that writes a stock table must either record its movement through this package or
// be a deliberate, explained non-mover. Like the stock-seq guard it cannot see through
// helpers, so it works per FILE; a file with a stock write that is not classified
// fails here and its author has to decide.

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

// goSources returns the non-test, non-generated Go files under root/<dirs>, keyed by
// path relative to root with forward slashes.
func goSources(t *testing.T, root string, dirs ...string) map[string]string {
	t.Helper()
	out := map[string]string{}
	for _, dir := range dirs {
		err := filepath.WalkDir(filepath.Join(root, dir), func(p string, d os.DirEntry, err error) error {
			if err != nil {
				return err
			}
			n := d.Name()
			if d.IsDir() || !strings.HasSuffix(n, ".go") || strings.HasSuffix(n, "_test.go") || n == "api.gen.go" {
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
	}
	return out
}

func sortedKeys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// ---- append-only ----

var movementMutation = regexp.MustCompile(
	`(?is)\b(UPDATE|DELETE\s+FROM|TRUNCATE(\s+TABLE)?|MERGE\s+INTO)\s+(ONLY\s+)?("?public"?\.)?"?stock_movements\b`)

// An upsert that updates on conflict rewrites rows just like an UPDATE does. The
// statement is bounded by ';' or a closing backtick so it stays within one SQL string.
var movementUpsert = regexp.MustCompile(
	`(?is)\bINSERT\s+INTO\s+("?public"?\.)?"?stock_movements\b[^;` + "`" + `]*?\bON\s+CONFLICT\b[^;` + "`" + `]*?\bDO\s+UPDATE\b`)

// movementViolation returns what in src would change or remove ledger rows, or "".
func movementViolation(src string) string {
	if loc := movementMutation.FindStringIndex(src); loc != nil {
		return src[loc[0]:loc[1]]
	}
	if loc := movementUpsert.FindStringIndex(src); loc != nil {
		return "INSERT ... ON CONFLICT DO UPDATE on stock_movements"
	}
	return ""
}

func TestStockMovementsIsAppendOnly(t *testing.T) {
	root := backendRoot(t)
	srcs := goSources(t, root, "internal", "cmd")
	migs, err := filepath.Glob(filepath.Join(root, "internal", "db", "migrations", "*.sql"))
	if err != nil || len(migs) == 0 {
		t.Fatalf("no migrations found: %v", err)
	}
	for _, m := range migs {
		raw, err := os.ReadFile(m)
		if err != nil {
			t.Fatal(err)
		}
		srcs["internal/db/migrations/"+filepath.Base(m)] = string(raw)
	}
	for _, n := range sortedKeys(srcs) {
		if v := movementViolation(srcs[n]); v != "" {
			t.Errorf("%s changes or removes stock_movements rows (%q): the ledger is append-only, record a compensating movement instead", n, v)
		}
	}
}

func TestAppendOnlyGuardRejectsBadShapes(t *testing.T) {
	cases := []struct {
		name, src string
		bad       bool
	}{
		{"update", "UPDATE stock_movements SET qty=1", true},
		{"update lower case", "update   stock_movements set qty=1", true},
		{"update newline", "UPDATE\n\tstock_movements SET qty=1", true},
		{"update only", "UPDATE ONLY stock_movements SET qty=1", true},
		{"update public qualified", "UPDATE public.stock_movements SET qty=1", true},
		{"update quoted qualified", `UPDATE "public"."stock_movements" SET qty=1`, true},
		{"delete", "DELETE FROM stock_movements WHERE id=$1", true},
		{"delete spaced", "delete\n  from  stock_movements", true},
		{"delete public qualified", "DELETE FROM public.stock_movements", true},
		{"truncate", "TRUNCATE stock_movements", true},
		{"truncate table", "truncate table stock_movements", true},
		{"truncate public", "TRUNCATE TABLE public.stock_movements", true},
		{"merge", "MERGE INTO stock_movements m USING x ON m.id = x.id", true},
		{"merge public", "merge into public.stock_movements m USING x ON true", true},
		{"upsert do update", "INSERT INTO stock_movements (id) VALUES ($1) ON CONFLICT (dedupe_key) DO UPDATE SET qty = 1", true},
		{"upsert do update multi-line", "INSERT INTO stock_movements (id)\nVALUES ($1)\nON CONFLICT (dedupe_key)\n  DO\n  UPDATE SET qty = 1", true},
		{"upsert do update public", "INSERT INTO public.stock_movements (id) VALUES ($1) ON CONFLICT DO UPDATE SET x=1", true},
		{"insert do nothing is fine", "INSERT INTO stock_movements (id) VALUES ($1) ON CONFLICT (dedupe_key) DO NOTHING", false},
		{"insert is fine", "INSERT INTO stock_movements (id) VALUES ($1)", false},
		{"select is fine", "SELECT sum(qty) FROM stock_movements", false},
		{"other table is fine", "UPDATE stock_movement_notes SET x=1", false},
		{"other table upsert in next statement is fine", "INSERT INTO stock_movements (id) VALUES ($1); INSERT INTO t (a) VALUES (1) ON CONFLICT (a) DO UPDATE SET a=2", false},
	}
	for _, c := range cases {
		if got := movementViolation(c.src) != ""; got != c.bad {
			t.Errorf("%s: flagged=%v want %v", c.name, got, c.bad)
		}
	}
}

// ---- every stock writer records ----

var stockTableWrite = regexp.MustCompile(`(?i)(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(outlet|warehouse)_variant_stock\b`)

var ledgerCall = regexp.MustCompile(`\bledger\.(Record|RecordDeltas|Backfill)\(`)

// hasStockWrite reports a literal write on a stock table, or a stock table name used
// as a Go string value (dynamic SQL that targets either table).
func hasStockWrite(src string) bool {
	return stockTableWrite.MatchString(src) ||
		strings.Contains(src, `"outlet_variant_stock"`) || strings.Contains(src, `"warehouse_variant_stock"`)
}

// ledgerHookFiles: stock-writer file -> name of the helper (in another file) it must
// call to record, for writers whose recording lives in a hook file (e.g. the sale and
// refund hooks in service/ledger_hooks.go).
// S2: service/ledger_hooks.go itself now writes a stock table (the per-sale giveaway decrement)
// and calls ledger.Record directly, so the classifier counts it as a recording writer on its
// own; it is deliberately in neither ledgerHookFiles nor ledgerNonMovers.
var ledgerHookFiles = map[string]string{
	"internal/write/transfer.go": "recordTransferMovements", // write/transfer_ledger.go
	"internal/service/refund.go": "recordRefundMovements",   // service/ledger_hooks.go
	"internal/service/order.go":  "recordSaleMovements",     // service/ledger_hooks.go
}

// ledgerNonMovers: files that write stock tables without changing any quantity, with
// the reason. A file that also holds a real mover must NOT be listed here.
var ledgerNonMovers = map[string]string{
	"internal/service/lockorder.go":     "lazy zero row (INSERT ... stock 0 ON CONFLICT DO NOTHING) so the sorted row lock has something to lock; quantity unchanged",
	"internal/write/import_products.go": "renames/moves only zero-stock keys (D13 guard)",
	"internal/write/catalog.go":         "create refuses opening stock (D12), so it writes no stock row; renames/deletes move only zero rows under the D13 guard (L7)",
}

// ledgerPendingWriters: movers not yet converted, with the task that converts them.
// Step 2 is complete, so it is empty and TestLedgerNoPendingWriters keeps it that way.
var ledgerPendingWriters = map[string]string{}

// classifyStockWriters returns the problems found for the given sources.
func classifyStockWriters(srcs map[string]string, hooks, nonMovers, pending map[string]string) []string {
	var bad []string
	for _, n := range sortedKeys(srcs) {
		_, inH := hooks[n]
		_, inN := nonMovers[n]
		_, inP := pending[n]
		if (inH && inN) || (inH && inP) || (inN && inP) {
			bad = append(bad, n+" is listed in more than one of ledgerHookFiles, ledgerNonMovers, ledgerPendingWriters")
		}
		if h, ok := hooks[n]; ok && (!hasStockWrite(srcs[n]) || !strings.Contains(srcs[n], h+"(")) {
			bad = append(bad, n+" is in ledgerHookFiles but no longer writes a stock table or calls "+h+": remove the stale entry")
		}
		src := srcs[n]
		writes := hasStockWrite(src)
		records := ledgerCall.MatchString(src)
		if h, ok := hooks[n]; ok {
			records = records || strings.Contains(src, h+"(")
		}
		_, isNon := nonMovers[n]
		_, isPending := pending[n]
		switch {
		case writes && !records && !isNon && !isPending:
			bad = append(bad, n+" writes a stock table but never calls ledger.Record/RecordDeltas (or a listed hook): record the movement, or list it in ledgerNonMovers with a reason")
		case isNon && !writes:
			bad = append(bad, n+" is in ledgerNonMovers but no longer writes a stock table: remove the stale entry")
		case isNon && records:
			bad = append(bad, n+" is in ledgerNonMovers but records movements: remove it from ledgerNonMovers")
		case isPending && !writes:
			bad = append(bad, n+" is in ledgerPendingWriters but no longer writes a stock table: remove the stale entry")
		case isPending && records:
			bad = append(bad, n+" is in ledgerPendingWriters but already records movements: remove the stale entry")
		}
	}
	for _, m := range []map[string]string{hooks, nonMovers, pending} {
		for n := range m {
			if _, ok := srcs[n]; !ok {
				bad = append(bad, n+" is listed in a ledger guard map but does not exist")
			}
		}
	}
	return bad
}

func TestLedgerEveryStockWriterRecords(t *testing.T) {
	srcs := goSources(t, backendRoot(t), "internal")
	for _, v := range classifyStockWriters(srcs, ledgerHookFiles, ledgerNonMovers, ledgerPendingWriters) {
		t.Error(v)
	}
}

// Step 2 (stock ledger) is complete: every stock writer records or is an explained
// non-mover. Parking a writer again means editing this test on purpose.
func TestLedgerNoPendingWriters(t *testing.T) {
	if len(ledgerPendingWriters) != 0 {
		t.Errorf("ledgerPendingWriters must stay empty after L8, got %v", sortedKeys(ledgerPendingWriters))
	}
}

// The scanner must really fail on bad shapes; a guard that cannot fail guards nothing.
func TestLedgerWriterGuardRejectsBadShapes(t *testing.T) {
	writer := "package p\nconst q = `UPDATE outlet_variant_stock SET stock = stock - 1`\n"
	recorder := writer + "func f() { _, _ = ledger.Record(ctx, tx, doc) }\n"
	dynamic := "package p\nvar t = \"warehouse_variant_stock\"\n"
	reader := "package p\nconst q = `SELECT stock FROM outlet_variant_stock`\n"
	none := map[string]string{}

	cases := []struct {
		name    string
		srcs    map[string]string
		hooks   map[string]string
		non     map[string]string
		pending map[string]string
		bad     bool
	}{
		{"fake writer is detected", map[string]string{"w.go": writer}, none, none, none, true},
		{"dynamic table value is detected", map[string]string{"w.go": dynamic}, none, none, none, true},
		{"reader is not a writer", map[string]string{"r.go": reader}, none, none, none, false},
		{"recording writer passes", map[string]string{"w.go": recorder}, none, none, none, false},
		{"hook writer passes", map[string]string{"w.go": writer + "func f() { recordHook(ctx) }\n"},
			map[string]string{"w.go": "recordHook"}, none, none, false},
		{"listed non-mover passes", map[string]string{"w.go": writer}, none, map[string]string{"w.go": "why"}, none, false},
		{"listed pending passes", map[string]string{"w.go": writer}, none, none, map[string]string{"w.go": "L2"}, false},
		{"stale non-mover", map[string]string{"r.go": reader}, none, map[string]string{"r.go": "why"}, none, true},
		{"stale pending (no write)", map[string]string{"r.go": reader}, none, none, map[string]string{"r.go": "L2"}, true},
		{"stale pending (already records)", map[string]string{"w.go": recorder}, none, none, map[string]string{"w.go": "L2"}, true},
		{"stale hook entry (hook not called)", map[string]string{"w.go": writer}, map[string]string{"w.go": "recordHook"}, none, none, true},
		{"stale hook entry (no write)", map[string]string{"r.go": reader + "func f() { recordHook(ctx) }\n"}, map[string]string{"r.go": "recordHook"}, none, none, true},
		{"file in two lists", map[string]string{"w.go": writer}, none, map[string]string{"w.go": "why"}, map[string]string{"w.go": "L2"}, true},
		{"listed file missing", map[string]string{}, none, none, map[string]string{"gone.go": "L2"}, true},
	}
	for _, c := range cases {
		got := classifyStockWriters(c.srcs, c.hooks, c.non, c.pending)
		if (len(got) > 0) != c.bad {
			t.Errorf("%s: problems=%v wantBad=%v", c.name, got, c.bad)
		}
	}
}
