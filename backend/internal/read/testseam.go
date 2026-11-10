package read

import "context"

// Test seams for the PostgreSQL gate in package handlers (the gate only runs that package).
// They expose no behaviour the repo does not already have.

// OrderWhere renders the orders WHERE clause of f, so a parity test can run the retired
// count(*) OVER() statement against exactly the filter the new statements use.
func OrderWhere(f OrderFilter) (string, []any) { return buildOrderWhere(f) }

// JITProbe reports the `jit` setting seen inside the paged-list batch (what the list
// statements run under) and on the next plain query of the same connection. A test pool
// with one connection proves the batch's SET LOCAL reaches the statement and resets after.
func (r *Repo) JITProbe(ctx context.Context) (inBatch, afterwards string, err error) {
	rows, _, err := pagedCountJSON[map[string]string](ctx, r.Pool,
		`SELECT json_build_object('jit', current_setting('jit')), 1`)
	if err != nil || len(rows) != 1 {
		return "", "", err
	}
	err = r.Pool.QueryRow(ctx, `SELECT current_setting('jit')`).Scan(&afterwards)
	return rows[0]["jit"], afterwards, err
}
