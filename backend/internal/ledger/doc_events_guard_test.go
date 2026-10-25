package ledger

import (
	"os"
	"path/filepath"
	"regexp"
	"testing"
)

// inventory_doc_events (migration 0068) is the append-only history of counts, adjustment
// requests, requisitions and giveaway settings. Like stock_movements it is guarded here, not by a
// REVOKE (single DB role). The guard lives beside the ledger guard because it reuses its source
// walker, and it scans every non-test Go file under internal/ and cmd/ plus the migrations, so it
// does not matter which package (write/, read/, handlers/) ends up owning the writer.

var docEventMutation = regexp.MustCompile(
	`(?is)\b(UPDATE|DELETE\s+FROM|TRUNCATE(\s+TABLE)?|MERGE\s+INTO)\s+(ONLY\s+)?("?public"?\.)?"?inventory_doc_events\b`)

// An upsert that updates on conflict rewrites rows just like an UPDATE does. The statement is
// bounded by ';' or a closing backtick so it stays within one SQL string.
var docEventUpsert = regexp.MustCompile(
	`(?is)\bINSERT\s+INTO\s+("?public"?\.)?"?inventory_doc_events\b[^;` + "`" + `]*?\bON\s+CONFLICT\b[^;` + "`" + `]*?\bDO\s+UPDATE\b`)

// docEventViolation returns what in src would change or remove history rows, or "".
func docEventViolation(src string) string {
	if loc := docEventMutation.FindStringIndex(src); loc != nil {
		return src[loc[0]:loc[1]]
	}
	if loc := docEventUpsert.FindStringIndex(src); loc != nil {
		return "INSERT ... ON CONFLICT DO UPDATE on inventory_doc_events"
	}
	return ""
}

func TestInventoryDocEventsIsAppendOnly(t *testing.T) {
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
		if v := docEventViolation(srcs[n]); v != "" {
			t.Errorf("%s changes or removes inventory_doc_events rows (%q): the history is append-only, insert a new event instead", n, v)
		}
	}
}

func TestDocEventsAppendOnlyGuardRejectsBadShapes(t *testing.T) {
	cases := []struct {
		name, src string
		bad       bool
	}{
		{"update", "UPDATE inventory_doc_events SET note='x'", true},
		{"update lower case", "update   inventory_doc_events set note='x'", true},
		{"update newline", "UPDATE\n\tinventory_doc_events SET note='x'", true},
		{"update public qualified", "UPDATE public.inventory_doc_events SET note='x'", true},
		{"update quoted qualified", `UPDATE "public"."inventory_doc_events" SET note='x'`, true},
		{"delete", "DELETE FROM inventory_doc_events WHERE id=$1", true},
		{"delete spaced", "delete\n  from  inventory_doc_events", true},
		{"truncate", "TRUNCATE inventory_doc_events", true},
		{"truncate table public", "TRUNCATE TABLE public.inventory_doc_events", true},
		{"merge", "MERGE INTO inventory_doc_events e USING x ON e.id = x.id", true},
		{"upsert do update", "INSERT INTO inventory_doc_events (doc_id) VALUES ($1) ON CONFLICT (id) DO UPDATE SET note = 'x'", true},
		{"upsert do update multi-line", "INSERT INTO inventory_doc_events (doc_id)\nVALUES ($1)\nON CONFLICT (id)\n  DO\n  UPDATE SET note = 'x'", true},
		{"insert is fine", "INSERT INTO inventory_doc_events (doc_type, doc_id, action) VALUES ($1, $2, $3)", false},
		{"insert do nothing is fine", "INSERT INTO inventory_doc_events (doc_id) VALUES ($1) ON CONFLICT DO NOTHING", false},
		{"select is fine", "SELECT action, at FROM inventory_doc_events WHERE doc_id = $1 ORDER BY id", false},
		{"other table is fine", "UPDATE inventory_doc_events_archive SET x=1", false},
		{"other table upsert in next statement is fine", "INSERT INTO inventory_doc_events (doc_id) VALUES ($1); INSERT INTO t (a) VALUES (1) ON CONFLICT (a) DO UPDATE SET a=2", false},
	}
	for _, c := range cases {
		if got := docEventViolation(c.src) != ""; got != c.bad {
			t.Errorf("%s: flagged=%v want %v", c.name, got, c.bad)
		}
	}
}
