package handlers

import (
	"fmt"
	"reflect"
	"sort"

	"github.com/mandalika/pos-backend/internal/tenderlines"
)

// Subtest 14: tenderlines.Lateral (per order) and tenderlines.SetLines (set-based, used by the
// report summary) must yield the same payment lines for the same orders.

func (e *spEnv) tenderLine(order string, seq int, method string, amount float64) {
	e.t.Helper()
	e.exec(`INSERT INTO order_tenders(order_id,seq,method,amount,tendered) VALUES($1,$2,$3,$4,$4)`, order, seq, method, amount)
}

func (e *spEnv) lineRows(sql string, args ...any) []string {
	e.t.Helper()
	rows, err := e.pool.Query(e.ctx, sql, args...)
	if err != nil {
		e.t.Fatalf("%v: %s", err, sql)
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id, method, amount string
		var synthetic bool
		if err := rows.Scan(&id, &method, &amount, &synthetic); err != nil {
			e.t.Fatal(err)
		}
		out = append(out, fmt.Sprintf("%s|%q|%s|%v", id, method, amount, synthetic))
	}
	if err := rows.Err(); err != nil {
		e.t.Fatal(err)
	}
	sort.Strings(out)
	return out
}

// legacySetLines is the retired hash-join plus anti-join form of tenderlines.SetLines, kept here
// as the reference the LATERAL form must match row for row.
func legacySetLines(base string, keep []string) string {
	cols := ""
	for _, c := range keep {
		cols += ", o." + c
	}
	return fmt.Sprintf(`
SELECT o.id%[2]s, t.method, t.amount, false AS synthetic
  FROM %[1]s o JOIN order_tenders t ON t.order_id = o.id
UNION ALL
SELECT o.id%[2]s, o.payment_method, o.total, true
  FROM %[1]s o WHERE NOT EXISTS (SELECT 1 FROM order_tenders t2 WHERE t2.order_id = o.id)`, base, cols)
}

func (e *spEnv) lateralAndSetLines() {
	o := e.newOutlet()
	stored := e.rawOrder(o, "qris", "completed", 30000, "")
	e.tenderLine(stored, 1, "qris", 30000)
	e.rawOrder(o, "cash", "completed", 20000, "") // tenderless: one synthetic line
	split := e.rawOrder(o, "split", "completed", 100000, "")
	e.tenderLine(split, 1, "qris", 60000)
	e.tenderLine(split, 2, "cash", 40000)
	zero := e.rawOrder(o, "qris", "completed", 40000, "")
	e.tenderLine(zero, 1, "qris", 40000)
	e.tenderLine(zero, 2, "cash", 0) // zero-amount line is still a line
	spaced := e.rawOrder(o, "card", "completed", 15000, "")
	e.tenderLine(spaced, 1, "  QRIS ", 15000)       // stored method keeps its case and padding
	e.rawOrder(o, "Qris ", "completed", 12000, "")  // synthetic line with case and padding
	e.rawOrder(o, "transfer", "refunded", 9000, "") // status does not matter to the lines
	three := e.rawOrder(o, "split", "partially_refunded", 90000, "")
	e.tenderLine(three, 1, "qris", 50000)
	e.tenderLine(three, 2, "cash", 30000)
	e.tenderLine(three, 3, "card", 10000)
	base := fmt.Sprintf("(SELECT id, payment_method, total FROM orders WHERE outlet_id='%s')", o.id)
	outlet := fmt.Sprintf("o.outlet_id='%s'", o.id)
	for _, m := range []string{"", "qris", "QRIS ", "cash", "card", "transfer", "split"} {
		var lateral, set, legacy []string
		if m == "" {
			lateral = e.lineRows(`SELECT o.id::text, tl.method, tl.amount::text, tl.synthetic FROM orders o ` + tenderlines.Lateral + ` WHERE ` + outlet)
			set = e.lineRows(`SELECT l.id::text, l.method, l.amount::text, l.synthetic FROM (` + tenderlines.SetLines(base, nil) + `) l`)
			legacy = e.lineRows(`SELECT l.id::text, l.method, l.amount::text, l.synthetic FROM (` + legacySetLines(base, nil) + `) l`)
		} else {
			lateral = e.lineRows(`SELECT o.id::text, tl.method, tl.amount::text, tl.synthetic FROM orders o `+tenderlines.Lateral+
				` WHERE `+outlet+` AND lower(btrim(tl.method)) = lower(btrim($1))`, m)
			set = e.lineRows(`SELECT l.id::text, l.method, l.amount::text, l.synthetic FROM (`+tenderlines.SetLines(base, nil)+
				`) l WHERE lower(btrim(l.method)) = lower(btrim($1))`, m)
			legacy = e.lineRows(`SELECT l.id::text, l.method, l.amount::text, l.synthetic FROM (`+legacySetLines(base, nil)+
				`) l WHERE lower(btrim(l.method)) = lower(btrim($1))`, m)
		}
		if !reflect.DeepEqual(lateral, set) {
			e.t.Fatalf("method=%q: lateral and set-based lines differ\n lateral %v\n set     %v", m, lateral, set)
		}
		if !reflect.DeepEqual(legacy, set) {
			e.t.Fatalf("method=%q: retired and LATERAL set lines differ\n legacy %v\n set    %v", m, legacy, set)
		}
		if m == "" && len(lateral) != 12 {
			e.t.Fatalf("fixture must give 12 lines, got %d: %v", len(lateral), lateral)
		}
	}
}
