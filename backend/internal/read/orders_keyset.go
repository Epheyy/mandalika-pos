package read

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/mandalika/pos-backend/internal/api"
)

// ErrKeysetRefundBasis: a refund-basis list sorts on max(refunded_at), a mutable key, so it
// cannot be paged by keyset. Those lists keep offset paging.
var ErrKeysetRefundBasis = errors.New("keyset paging does not support dateBasis=refund")

// OrdersKeyset is one page of the orders export (sale basis). Each page is a single
// statement carrying its own exact count (A26), frozen at asOf:
//   - the first page (after == nil) applies created_at <= statement_timestamp() to BOTH its
//     count and its rows and hands that instant out inside the cursor;
//   - later pages apply created_at <= cursor.AsOf to both, plus the (created_at, id) position
//     to the rows only.
//
// So a sale arriving after the export started is outside the frozen filter, while a
// transaction that began before asOf and commits later (or a refund that moves a status
// filter) still changes the count and fails the export client-side.
//
// asOf is the frozen cut-off (server time) of the whole export; next is set iff the page is full (len(rows) == limit); the client stops on total, not on
// next. The caller must not request a refund-basis filter.
func (r *Repo) OrdersKeyset(ctx context.Context, f OrderFilter, after *OrderCursor, limit int) (rows []api.Order, total int, next *OrderCursor, asOf time.Time, err error) {
	if f.refundBasis() {
		return nil, 0, nil, time.Time{}, ErrKeysetRefundBasis
	}
	args := []any{}
	add := func(v any) int {
		args = append(args, v)
		return len(args)
	}
	asOfExpr := "statement_timestamp()"
	if after != nil {
		asOfExpr = fmt.Sprintf("$%d::timestamptz", add(after.AsOf))
	}
	asOfBound := " AND o.created_at <= " + asOfExpr
	cursorPred := ""
	var sql string
	var setBody string
	indexed := useSearchIndex(f)
	if indexed {
		setBody, args = orderSearchSet(f, orderSetCols(f), asOfBound, args)
	}
	var where string
	if !indexed {
		where, args = appendOrderWhere(f, args, false)
	}
	if after != nil {
		c, i := add(after.CreatedAt), add(after.ID)
		cursorPred = fmt.Sprintf("(created_at, id) < ($%d::timestamptz, $%d::uuid)", c, i)
	}
	limitOffset := fmt.Sprintf("$%d", add(limit))
	extraCols := ", pg.created_at, pg.id::text, " + asOfExpr + " AS asof"
	prelude := jitOffSQL
	if indexed {
		prelude = searchPreludeSQL
		sql = orderPageSQLFromSet(f, setBody, cursorPred, limitOffset, extraCols)
	} else {
		// A q or payment-method filter has no index to walk: evaluate it once (MATERIALIZED), as
		// the offset path does. The cursor predicate narrows only the page in both forms.
		materialize := f.Q != "" || f.PaymentMethod != ""
		sql = orderPageSQL(f, where+asOfBound, cursorPred, limitOffset, extraCols, materialize)
	}

	rows = []api.Order{}
	var lastCreated *time.Time
	var lastID *string
	err = pagedBatchPrelude(ctx, r.Pool, prelude, sql, args, func(rs pgx.Rows) error {
		for rs.Next() {
			var raw []byte
			var created *time.Time
			var id *string
			if err := rs.Scan(&raw, &total, &created, &id, &asOf); err != nil {
				return fmt.Errorf("scan: %w", err)
			}
			if raw == nil {
				continue
			}
			var o api.Order
			if err := json.Unmarshal(raw, &o); err != nil {
				return fmt.Errorf("unmarshal: %w", err)
			}
			rows = append(rows, o)
			lastCreated, lastID = created, id
		}
		return rs.Err()
	})
	if err != nil {
		return nil, 0, nil, time.Time{}, err
	}
	if len(rows) == limit && lastCreated != nil && lastID != nil {
		next = &OrderCursor{AsOf: asOf, CreatedAt: *lastCreated, ID: *lastID}
	}
	return rows, total, next, asOf, nil
}
