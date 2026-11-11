package read

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mandalika/pos-backend/internal/phone"
)

// searchPreludeSQL turns JIT off and forces custom plans for the rest of the current
// transaction only. A generic plan is reused for every term and is measurably worse for the
// search statement (3.3 s against 2.5 s custom for a term matching every order).
const searchPreludeSQL = `SELECT set_config('jit','off',true), set_config('plan_cache_mode','force_custom_plan',true)`

// useSearchIndex reports whether the list's q uses the indexed two-arm UNION statement. The
// shift and customer filters already drive a tiny index set (POS recap, CustomerDetail), and a
// term without a trigram cannot use the indexes, so those keep the single-WHERE statement.
// Both shapes return the same rows (A26); the gate only picks the plan shape.
func useSearchIndex(f OrderFilter) bool {
	switch f.searchForm {
	case 1:
		return false
	case 2:
		return f.Q != ""
	}
	return f.Q != "" && trigramUsable(f.Q) && f.ShiftID == "" && f.CustomerID == ""
}

// orderSetCols is the select list of the filtered set: the sort key columns (plus the refund
// key k on the refund basis).
func orderSetCols(f OrderFilter) string {
	cols := "o.id, o.created_at"
	if f.refundBasis() {
		cols += ", " + refundOrderKey + " AS k"
	}
	return cols
}

// orderSearchSet builds the filtered set of an indexed search as a UNION of two arms, which
// lets the planner use a BitmapOr over the trigram indexes (the single OR ... OR EXISTS
// cannot). W AND (A OR B) = (W AND A) UNION (W AND B); UNION de-duplicates an order matching
// both arms (id is the primary key). extra is ANDed into every arm (the keyset asOf bound).
// args are the placeholders already taken; the returned slice extends them.
func orderSearchSet(f OrderFilter, cols, extra string, args []any) (body string, out []any) {
	base := f
	base.Q = ""
	where, out := appendOrderWhere(base, args, false)
	where += extra
	add := func(v any) int {
		out = append(out, v)
		return len(out)
	}
	n := add(qPattern(f.Q))
	var arm1, arm2 string
	if f.CustomerSearch {
		arm1 = fmt.Sprintf(`(o.order_number ILIKE $%[1]d OR o.cashier_name ILIKE $%[1]d OR o.customer_name ILIKE $%[1]d)`, n)
		arm2 = fmt.Sprintf(`o.customer_id IN (SELECT c.id FROM customers c WHERE c.phone ILIKE $%[1]d OR c.name ILIKE $%[1]d)`, n)
	} else {
		arm1 = fmt.Sprintf(`(o.order_number ILIKE $%[1]d OR o.cashier_name ILIKE $%[1]d)`, n)
		if norm := phone.Normalize(f.Q); norm != "" {
			// Today's clause has no merged_into condition, so both halves are needed; split this
			// way the partial phone_norm indexes serve each.
			k := add(norm)
			arm2 = fmt.Sprintf(`o.customer_id IN (SELECT id FROM customers WHERE phone_norm = $%[1]d AND merged_into IS NULL
		    UNION ALL SELECT id FROM customers WHERE phone_norm = $%[1]d AND merged_into IS NOT NULL)`, k)
		}
	}
	body = fmt.Sprintf("SELECT %s FROM orders o %s AND %s", cols, where, arm1)
	if arm2 != "" {
		body += fmt.Sprintf("\n\t  UNION\n\t  SELECT %s FROM orders o %s AND %s", cols, where, arm2)
	}
	return body, out
}

// pagedSearchJSON is pagedCountJSON under searchPreludeSQL (JIT off + custom plan).
func pagedSearchJSON[T any](ctx context.Context, p *pgxpool.Pool, sql string, args ...any) ([]T, int, error) {
	var out []T
	var total int
	err := pagedBatchPrelude(ctx, p, searchPreludeSQL, sql, args, func(rows pgx.Rows) error {
		var err error
		out, total, err = decodePaged[T](rows)
		return err
	})
	if err != nil {
		return nil, 0, err
	}
	return out, total, nil
}
