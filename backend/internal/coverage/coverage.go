// Package coverage answers "which outlets may this user act on?". It is an infra-tier
// package (it only imports pgx, no other internal package) so auth, middleware, scope and sync
// can all share one rule.
package coverage

import (
	"context"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
)

// Coverage is the set of outlets a user covers: every outlet (All) or an explicit list.
type Coverage struct {
	All       bool
	OutletIDs []string
}

// Covers reports whether the outlet is covered. An empty id is never covered.
func (c Coverage) Covers(outletID string) bool {
	if outletID == "" {
		return false
	}
	if c.All {
		return true
	}
	for _, id := range c.OutletIDs {
		if strings.EqualFold(id, outletID) {
			return true
		}
	}
	return false
}

// merge returns home first, then extras, deduped case-insensitively; an empty home is dropped.
// Never nil.
func merge(home string, extras []string) []string {
	out := []string{}
	add := func(id string) {
		if id == "" {
			return
		}
		for _, have := range out {
			if strings.EqualFold(have, id) {
				return
			}
		}
		out = append(out, id)
	}
	add(home)
	for _, e := range extras {
		add(e)
	}
	return out
}

// Of derives coverage from a user's role, home outlet, extra outlets and all-outlets flag.
func Of(role, home string, extras []string, allOutlets bool) Coverage {
	switch role {
	case "admin":
		return Coverage{All: true}
	case "manager":
		if allOutlets {
			return Coverage{All: true}
		}
		if home == "" {
			// No home outlet and not all-outlets: unassigned, whatever user_outlets holds.
			return Coverage{OutletIDs: []string{}}
		}
		return Coverage{OutletIDs: merge(home, extras)}
	case "cashier":
		return Coverage{OutletIDs: merge(home, nil)}
	}
	return Coverage{}
}

// SelectCols is appended to a `SELECT ... FROM users u` and scans as (bool, []string).
const SelectCols = "u.all_outlets, ARRAY(SELECT uo.outlet_id::text FROM user_outlets uo WHERE uo.user_id = u.id ORDER BY uo.outlet_id)"

// Querier is the read surface shared by a pool and a transaction.
type Querier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// Load reads a user's role, home outlet and coverage. An unknown user wraps pgx.ErrNoRows.
func Load(ctx context.Context, q Querier, userID string) (role, home string, cov Coverage, err error) {
	var homeP *string
	var all bool
	var extras []string
	err = q.QueryRow(ctx,
		`SELECT u.role, u.outlet_id::text, `+SelectCols+` FROM users u WHERE u.id = $1`, userID,
	).Scan(&role, &homeP, &all, &extras)
	if err != nil {
		return "", "", Coverage{}, fmt.Errorf("load coverage: %w", err)
	}
	if homeP != nil {
		home = *homeP
	}
	return role, home, Of(role, home, extras, all), nil
}
