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
	sql := `SELECT json_build_object(
	  'id', dc.id,
	  'phone', dc.phone,
	  'status', dc.status,
	  'createdAt', dc.created_at,
	  'newCustomer',      (SELECT ` + customerObj + ` FROM customers WHERE id = dc.new_customer_id),
	  'existingCustomer', (SELECT ` + customerObj + ` FROM customers WHERE id = dc.existing_customer_id)
	), count(*) OVER() AS total
	FROM customer_dup_candidates dc
	WHERE dc.status = $3
	ORDER BY dc.created_at DESC, dc.id DESC
	OFFSET $1 LIMIT $2`
	return listJSON[api.DupCandidate](ctx, r.Pool, sql, off(page, limit), limit, status)
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
