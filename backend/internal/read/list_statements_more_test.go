package read

import (
	"strings"
	"testing"
)

// Wave 2 slice C1: error logs, duplicate candidates, goods receipts and ingredient transfers
// use the id-first shape: no window total over the filtered set, and a unique id tie-break
// on both the page ids and the outer order.
func TestMoreListStatementsHaveNoWindowCount(t *testing.T) {
	elSQL, elArgs := errorLogsPageSQL("o1", "sync", "2026-01-01", "2026-02-01", 2, 25)
	dcSQL, dcArgs := dupCandidatesPageSQL("pending", 1, 1)
	grSQL, grArgs := goodsReceiptsPageSQL("(gr.created_at >= $1)", []any{"2026-01-01"}, 3, 10)
	itSQL, itArgs := ingredientTransfersPageSQL(1, 50, "sent", "2026-01-01", "2026-02-01", "outlet", "x")
	cases := []struct {
		name, sql, idKey string
		args             int
	}{
		{"error logs", elSQL, "e.id DESC", len(elArgs)},
		{"dup candidates", dcSQL, "id DESC", len(dcArgs)},
		{"goods receipts", grSQL, "gr.id DESC", len(grArgs)},
		{"ingredient transfers", itSQL, "t.id DESC", len(itArgs)},
	}
	for _, c := range cases {
		if overRe.MatchString(c.sql) {
			t.Errorf("%s: window function in list SQL", c.name)
		}
		if !strings.Contains(c.sql, c.idKey) || !strings.HasSuffix(c.sql, "pg.id DESC") {
			t.Errorf("%s: page ids and outer order must end in an id tie-break", c.name)
		}
		if !strings.Contains(c.sql, "LEFT JOIN pg ON true") {
			t.Errorf("%s: total must survive an empty page (t LEFT JOIN pg)", c.name)
		}
	}
	if len(elArgs) != 6 || len(dcArgs) != 3 || len(grArgs) != 3 || len(itArgs) != 6 {
		t.Errorf("arg counts changed: %d %d %d %d", len(elArgs), len(dcArgs), len(grArgs), len(itArgs))
	}
	// goods receipts: the limit and offset placeholders follow the filter args.
	if !strings.Contains(grSQL, "LIMIT $2 OFFSET $3") || grArgs[1] != 10 || grArgs[2] != 20 {
		t.Errorf("goods receipts paging args wrong: %v", grArgs)
	}
}
