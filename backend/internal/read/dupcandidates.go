package read

import (
	"context"

	"github.com/mandalika/pos-backend/internal/api"
)

// DupCandidates lists duplicate-customer candidates filtered by status, newest
// first. The embedded newCustomer / existingCustomer objects reuse customerObj
// whose bare column references resolve against the scalar subquery's own
// "FROM customers" — so segmentSel works correctly here.
func (r *Repo) DupCandidates(ctx context.Context, status string, page, limit int) ([]api.DupCandidate, int, error) {
	sql, args := dupCandidatesPageSQL(status, page, limit)
	return pagedCountJSON[api.DupCandidate](ctx, r.Pool, sql, args...)
}

// dupCandidatesPageSQL builds the id-first statement (see orderPageSQL). The Customers badge
// asks for limit 1 only to read the total, so the two customer objects per row are built for
// one row, not for every pending candidate.
func dupCandidatesPageSQL(status string, page, limit int) (string, []any) {
	sql := `WITH t AS (SELECT count(*) AS n FROM customer_dup_candidates WHERE status = $3),
	     pg AS (SELECT id, created_at FROM customer_dup_candidates WHERE status = $3
	             ORDER BY created_at DESC, id DESC OFFSET $1 LIMIT $2)
	SELECT CASE WHEN pg.id IS NULL THEN NULL ELSE json_build_object(
	  'id', dc.id,
	  'phone', dc.phone,
	  'status', dc.status,
	  'createdAt', dc.created_at,
	  'newCustomer',      (SELECT ` + customerObj + ` FROM customers WHERE id = dc.new_customer_id),
	  'existingCustomer', (SELECT ` + customerObj + ` FROM customers WHERE id = dc.existing_customer_id)
	) END, t.n
	  FROM t LEFT JOIN pg ON true LEFT JOIN customer_dup_candidates dc ON dc.id = pg.id
	 ORDER BY pg.created_at DESC, pg.id DESC`
	return sql, []any{off(page, limit), limit, status}
}

// DupCandidate returns a single duplicate-customer candidate by id.
func (r *Repo) DupCandidate(ctx context.Context, id string) (api.DupCandidate, error) {
	sql := `SELECT json_build_object(
	  'id', dc.id,
	  'phone', dc.phone,
	  'status', dc.status,
	  'createdAt', dc.created_at,
	  'newCustomer',      (SELECT ` + customerObj + ` FROM customers WHERE id = dc.new_customer_id),
	  'existingCustomer', (SELECT ` + customerObj + ` FROM customers WHERE id = dc.existing_customer_id)
	)
	FROM customer_dup_candidates dc
	WHERE dc.id = $1`
	return oneJSON[api.DupCandidate](ctx, r.Pool, sql, id)
}
