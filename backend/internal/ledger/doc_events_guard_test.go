package ledger

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// inventory_doc_events (migration 0069) is the append-only history of counts, adjustment
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

// DROP TABLE and ALTER TABLE are structural changes to the history; only migration 0069 (which
// creates the table) may name it in DDL, so docEventViolation takes a flag for that file.
var docEventDDL = regexp.MustCompile(
	`(?is)\b(DROP\s+TABLE(\s+IF\s+EXISTS)?|ALTER\s+TABLE(\s+IF\s+EXISTS)?(\s+ONLY)?)\s+("?public"?\.)?"?inventory_doc_events\b`)

// SQL assembled at run time (`"UPDATE " + tbl`, `fmt.Sprintf("DELETE FROM %s", tbl)`) escapes the
// literal patterns above. Best effort: a mutating verb that is followed by a string join or a %s
// verb, with the table name literal within docEventNearby bytes of it.
var docEventDynamic = regexp.MustCompile(
	`(?is)\b(UPDATE|DELETE\s+FROM|TRUNCATE(\s+TABLE)?)\s*(%s|["` + "`" + `]\s*\+|\+\s*["` + "`" + `])`)

const docEventNearby = 300

// docEventViolation returns what in src would change or remove history rows, or "". isCreateMigration
// is true only for 0069, the one file allowed to run DDL on the table.
func docEventViolation(src string, isCreateMigration bool) string {
	if loc := docEventMutation.FindStringIndex(src); loc != nil {
		return src[loc[0]:loc[1]]
	}
	if !isCreateMigration {
		if loc := docEventDDL.FindStringIndex(src); loc != nil {
			return src[loc[0]:loc[1]]
		}
	}
	for _, loc := range docEventDynamic.FindAllStringIndex(src, -1) {
		lo, hi := max(0, loc[0]-docEventNearby), min(len(src), loc[1]+docEventNearby)
		if strings.Contains(src[lo:hi], "inventory_doc_events") {
			return "dynamically built " + strings.TrimSpace(src[loc[0]:loc[1]]) + " near inventory_doc_events"
		}
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
		if v := docEventViolation(srcs[n], n == "internal/db/migrations/0069_inventory_doc_events.sql"); v != "" {
			t.Errorf("%s changes or removes inventory_doc_events rows (%q): the history is append-only, insert a new event instead", n, v)
		}
	}
}

func TestDocEventsAppendOnlyGuardRejectsBadShapes(t *testing.T) {
	cases := []struct {
		name, src string
		bad       bool
		create    bool // pretend the source is migration 0069
	}{
		{"update", "UPDATE inventory_doc_events SET note='x'", true, false},
		{"update lower case", "update   inventory_doc_events set note='x'", true, false},
		{"update newline", "UPDATE\n\tinventory_doc_events SET note='x'", true, false},
		{"update public qualified", "UPDATE public.inventory_doc_events SET note='x'", true, false},
		{"update quoted qualified", `UPDATE "public"."inventory_doc_events" SET note='x'`, true, false},
		{"delete", "DELETE FROM inventory_doc_events WHERE id=$1", true, false},
		{"delete spaced", "delete\n  from  inventory_doc_events", true, false},
		{"truncate", "TRUNCATE inventory_doc_events", true, false},
		{"truncate table public", "TRUNCATE TABLE public.inventory_doc_events", true, false},
		{"merge", "MERGE INTO inventory_doc_events e USING x ON e.id = x.id", true, false},
		{"upsert do update", "INSERT INTO inventory_doc_events (doc_id) VALUES ($1) ON CONFLICT (id) DO UPDATE SET note = 'x'", true, false},
		{"upsert do update multi-line", "INSERT INTO inventory_doc_events (doc_id)\nVALUES ($1)\nON CONFLICT (id)\n  DO\n  UPDATE SET note = 'x'", true, false},
		{"drop table", "DROP TABLE inventory_doc_events", true, false},
		{"drop table if exists public", "drop table if exists public.inventory_doc_events cascade", true, false},
		{"alter table", "ALTER TABLE inventory_doc_events ADD COLUMN x int", true, false},
		{"alter table only quoted", `ALTER TABLE ONLY "public"."inventory_doc_events" DROP COLUMN x`, true, false},
		{"alter table in 0069 is allowed", "ALTER TABLE inventory_doc_events ADD COLUMN x int", false, true},
		{"update built by concatenation", `q := "UPDATE " + "inventory_doc_events" + " SET note = $1"`, true, false},
		{"delete built with Sprintf", "q := fmt.Sprintf(`DELETE FROM %s WHERE id = $1`, \"inventory_doc_events\")", true, false},
		{"concatenated update of another table is fine", `q := "UPDATE " + tbl + " SET a = 1"`, false, false},
		{"insert is fine", "INSERT INTO inventory_doc_events (doc_type, doc_id, action) VALUES ($1, $2, $3)", false, false},
		{"insert do nothing is fine", "INSERT INTO inventory_doc_events (doc_id) VALUES ($1) ON CONFLICT DO NOTHING", false, false},
		{"select is fine", "SELECT action, at FROM inventory_doc_events WHERE doc_id = $1 ORDER BY id", false, false},
		{"other table is fine", "UPDATE inventory_doc_events_archive SET x=1", false, false},
		{"other table upsert in next statement is fine", "INSERT INTO inventory_doc_events (doc_id) VALUES ($1); INSERT INTO t (a) VALUES (1) ON CONFLICT (a) DO UPDATE SET a=2", false, false},
	}
	for _, c := range cases {
		if got := docEventViolation(c.src, c.create) != ""; got != c.bad {
			t.Errorf("%s: flagged=%v want %v", c.name, got, c.bad)
		}
	}
}
