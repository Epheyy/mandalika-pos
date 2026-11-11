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

// SearchPlanProbe reports `jit` and `plan_cache_mode` inside the search batch (searchPreludeSQL)
// and on the next plain query of the same connection, like JITProbe.
func (r *Repo) SearchPlanProbe(ctx context.Context) (jitIn, planIn, jitAfter, planAfter string, err error) {
	rows, _, err := pagedSearchJSON[map[string]string](ctx, r.Pool,
		`SELECT json_build_object('jit', current_setting('jit'), 'plan', current_setting('plan_cache_mode')), 1`)
	if err != nil || len(rows) != 1 {
		return "", "", "", "", err
	}
	err = r.Pool.QueryRow(ctx, `SELECT current_setting('jit'), current_setting('plan_cache_mode')`).Scan(&jitAfter, &planAfter)
	return rows[0]["jit"], rows[0]["plan"], jitAfter, planAfter, err
}

// ForceSearchForm pins the list's q statement shape (indexed UNION or the single-WHERE legacy
// form) regardless of the useSearchIndex gate, so a parity test can compare both.
func ForceSearchForm(f *OrderFilter, indexed bool) {
	f.searchForm = 1
	if indexed {
		f.searchForm = 2
	}
}
